const API = "http://localhost:8001";

const state = {
    graphData: { nodes: [], links: [] },
    activeFilters: new Set([]),
    searchQuery: "",
    pendingEntry: null,
    pendingLinks: [],
    approvedLinks: new Set(),
    currentDiaryStep: 1, // using 1-based to match data-step in HTML
    diaryTags: [],
    freeformTags: [],
    sessionInterventionShown: false,
    hoveredNode: null
};

// D3 SETUP
const svg = d3.select("#graph-svg");
const container = svg.append("g");
const linkGroup = container.append("g").attr("class", "links-layer");
const nodeGroup = container.append("g").attr("class", "nodes-layer");

const zoom = d3.zoom()
    .scaleExtent([0.1, 4])
    .on("zoom", (e) => container.attr("transform", e.transform));
svg.call(zoom);

function resetView() {
    svg.transition().duration(750).call(zoom.transform, d3.zoomIdentity);
}

// ----------------------------------------------------
// SVG DEFINITIONS (FILTERS & CLIP PATHS)
// ----------------------------------------------------
const defs = svg.append("defs");

// Blueprint Drop Shadow
const dropShadow = defs.append("filter")
    .attr("id", "card-shadow")
    .attr("x", "-20%")
    .attr("y", "-20%")
    .attr("width", "140%")
    .attr("height", "140%");

dropShadow.append("feDropShadow")
    .attr("dx", 0)
    .attr("dy", 4)
    .attr("stdDeviation", 12)
    .attr("flood-opacity", 0.4)
    .attr("flood-color", "rgba(0,0,0,1)"); // Set to black by default, will dynamically match stroke via CSS/JS later, but standard is black/dark.

// Arrowhead marker for chronological links
defs.append("marker")
    .attr("id", "chrono-arrow")
    .attr("markerWidth", 6)
    .attr("markerHeight", 6)
    .attr("refX", 5)
    .attr("refY", 3)
    .attr("orient", "auto")
    .append("path")
    .attr("d", "M0,0 L0,6 L6,3 z")
    .attr("fill", "rgba(255,255,255,0.3)");

// Semantic arrow (teal)
defs.append("marker")
    .attr("id", "semantic-arrow")
    .attr("markerWidth", 6)
    .attr("markerHeight", 6)
    .attr("refX", 5)
    .attr("refY", 3)
    .attr("orient", "auto")
    .append("path")
    .attr("d", "M0,0 L0,6 L6,3 z")
    .attr("fill", "#4dd9c0");

// Compensatory arrow (amber)
defs.append("marker")
    .attr("id", "compensatory-arrow")
    .attr("markerWidth", 6)
    .attr("markerHeight", 6)
    .attr("refX", 5)
    .attr("refY", 3)
    .attr("orient", "auto")
    .append("path")
    .attr("d", "M0,0 L0,6 L6,3 z")
    .attr("fill", "#f4a942");

// Contextual arrow (violet)
defs.append("marker")
    .attr("id", "contextual-arrow")
    .attr("markerWidth", 6)
    .attr("markerHeight", 6)
    .attr("refX", 5)
    .attr("refY", 3)
    .attr("orient", "auto")
    .append("path")
    .attr("d", "M0,0 L0,6 L6,3 z")
    .attr("fill", "#7c6af7");

// Force simulation engine
let simulation = d3.forceSimulation()
    .force("link", d3.forceLink().id(d => d.id).distance(200).strength(0.4))
    .force("charge", d3.forceManyBody().strength(-280).distanceMax(500))
    .force("center", d3.forceCenter())
    .force("collide", d3.forceCollide().radius(110))
    .alphaDecay(0.02);

// TOOLTIP
const tooltip = d3.select("body").append("div")
    .attr("class", "hover-tooltip")
    .style("position", "fixed")
    .style("z-index", "90")
    .style("background", "rgba(17, 17, 24, 0.95)")
    .style("border", "1px solid rgba(255,255,255,0.06)")
    .style("border-radius", "6px")
    .style("padding", "12px")
    .style("color", "#e8e8f0")
    .style("font-family", "var(--font-body, sans-serif)")
    .style("font-size", "13px")
    .style("pointer-events", "none")
    .style("opacity", 0)
    .style("box-shadow", "0 4px 12px rgba(0,0,0,0.5)")
    .style("max-width", "250px");

// GRAPH RENDER FUNCTION
function renderGraph() {
    const width = svg.node().clientWidth || 800;
    const height = svg.node().clientHeight || 600;

    // Use all links for the new zero-strength physics engine binding
    const baseLinks = state.graphData.links;

    // Process links to cap Semantic links to 5 per node
    const semanticLinksRaw = baseLinks.filter(l => (l.type || l.link_type || '').toLowerCase() === 'semantic');
    const otherLinks = baseLinks.filter(l => (l.type || l.link_type || '').toLowerCase() !== 'semantic');

    // -- TRANSITIVE REDUCTION -------------------------------------------
    class TransitiveReducer {
        constructor(nodes, links) {
            this.nodes = new Map(nodes.map(n => [n.id, n]));
            this.links = links;
            this.adjacency = new Map();
            this.buildAdjacency();
        }

        buildAdjacency() {
            const chronological = this.links.filter(l => (l.type || l.link_type || '').toLowerCase() === 'chronological');
            chronological.forEach(link => {
                const source = typeof link.source === 'object' ? link.source.id : link.source;
                const target = typeof link.target === 'object' ? link.target.id : link.target;
                if (!this.adjacency.has(source)) {
                    this.adjacency.set(source, new Set());
                }
                this.adjacency.get(source).add(target);
            });
        }

        findPath(sourceId, targetId, maxHops = 10) {
            if (sourceId === targetId) return [sourceId];
            const queue = [[sourceId, [sourceId]]];
            const visited = new Set([sourceId]);

            while (queue.length > 0) {
                const [current, path] = queue.shift();
                if (path.length > maxHops) continue;
                const neighbors = this.adjacency.get(current) || new Set();
                for (const neighbor of neighbors) {
                    if (neighbor === targetId) return path.concat([neighbor]);
                    if (!visited.has(neighbor)) {
                        visited.add(neighbor);
                        queue.push([neighbor, path.concat([neighbor])]);
                    }
                }
            }
            return [];
        }

        reduce(semanticArray, options = {}) {
            const { minTemporalGap = 2, enabled = true } = options;
            if (!enabled) return semanticArray;

            return semanticArray.filter(link => {
                const sourceId = typeof link.source === 'object' ? link.source.id : link.source;
                const targetId = typeof link.target === 'object' ? link.target.id : link.target;
                const sourceEntry = this.nodes.get(sourceId);
                const targetEntry = this.nodes.get(targetId);

                if (!sourceEntry || !targetEntry) return false;

                const sDate = new Date(sourceEntry.timestamp || sourceEntry.date);
                const tDate = new Date(targetEntry.timestamp || targetEntry.date);

                if (isNaN(sDate) || isNaN(tDate)) return true; // keep if invalid dates

                const gap = Math.abs(tDate - sDate) / (1000 * 60 * 60 * 24);

                if (gap < minTemporalGap) {
                    const path = this.findPath(sourceId, targetId);
                    if (path.length > 0) return false; // Redundant chronological path exists
                }
                return true;
            });
        }
    }

    const reducer = new TransitiveReducer(state.graphData.nodes, baseLinks);
    const reducedSemanticLinks = reducer.reduce(semanticLinksRaw, { minTemporalGap: 2 });

    reducedSemanticLinks.sort((a, b) => (b.similarity || 0) - (a.similarity || 0));
    const nodeSemanticCounts = {};
    const cappedSemanticLinks = reducedSemanticLinks.filter(l => {
        const sourceId = typeof l.source === 'object' ? l.source.id : l.source;
        const targetId = typeof l.target === 'object' ? l.target.id : l.target;

        nodeSemanticCounts[sourceId] = (nodeSemanticCounts[sourceId] || 0) + 1;
        nodeSemanticCounts[targetId] = (nodeSemanticCounts[targetId] || 0) + 1;

        if (nodeSemanticCounts[sourceId] <= 5 || nodeSemanticCounts[targetId] <= 5) {
            return true;
        }
        return false;
    });

    const allLinks = [...otherLinks, ...cappedSemanticLinks];

    // Update Toggle Counts
    const counts = { chronological: 0, semantic: 0, compensatory: 0, contextual: 0 };
    allLinks.forEach(l => {
        const type = (l.type || l.link_type || '').toLowerCase();
        if (counts[type] !== undefined) counts[type]++;
    });
    Object.keys(counts).forEach(type => {
        const el = document.getElementById(`count-${type}`);
        if (el) el.textContent = `(${counts[type]})`;
    });

    const query = state.searchQuery.toLowerCase().trim();

    // Node highlight evaluation
    state.graphData.nodes.forEach(d => {
        if (!query) {
            d._highlighted = true;
            return;
        }
        const strOpts = [
            d.situation || "",
            d.text || "",
            d.automatic_thought || "",
            ...(d.tags || []),
            d.drift_label || "",
            d.wellness_label || ""
        ].join(" ").toLowerCase();

        d._highlighted = strOpts.includes(query);
    });

    // Link highlight evaluation for allLinks
    allLinks.forEach(l => {
        const sourceNode = typeof l.source === 'object' ? l.source : state.graphData.nodes.find(n => n.id === l.source);
        const targetNode = typeof l.target === 'object' ? l.target : state.graphData.nodes.find(n => n.id === l.target);

        if (!query) {
            l._highlighted = true;
        } else {
            l._highlighted = (sourceNode && sourceNode._highlighted) && (targetNode && targetNode._highlighted);
        }
    });

    // ----------------------------------------------------
    // START FORCE SIMULATION
    // ----------------------------------------------------

    // Resolve links into proper D3 object references before simulation
    // Nodes are already mapped correctly
    const readyLinks = allLinks.map(link => {
        const sIdx = typeof link.source === 'object' ? link.source.id : link.source;
        const tIdx = typeof link.target === 'object' ? link.target.id : link.target;
        return {
            ...link,
            source: state.graphData.nodes.find(n => n.id === sIdx) || link.source,
            target: state.graphData.nodes.find(n => n.id === tIdx) || link.target
        };
    }).filter(link => typeof link.source === 'object' && typeof link.target === 'object');

    simulation.force("center", d3.forceCenter(width / 2, height / 2));

    simulation
        .nodes(state.graphData.nodes)
        .on("tick", ticked);

    simulation.force("link").links(readyLinks);

    // Restart physics
    simulation.alpha(1).restart();

    // Render Links
    const getLinkColor = (t) => {
        if (t === 'semantic') return '#4dd9c0'; // teal/cyan
        if (t === 'compensatory') return '#f4a942'; // amber
        if (t === 'contextual') return '#7c6af7'; // violet
        if (t === 'chronological') return 'rgba(255,255,255,0.12)';
        return 'rgba(255,255,255,0.12)';
    };

    const link = linkGroup.selectAll("g.link-wrapper")
        .data(readyLinks, d => d.id || `${d.source.id || d.source}-${d.target.id || d.target}-${d.type}`);

    const linkEnter = link.join(
        enter => {
            const g = enter.append("g").attr("class", "link-wrapper")
                .style("transition", "opacity 0.3s ease");

            // Glow line (only for non-chronological)
            g.append("line")
                .attr("class", "graph-link-glow")
                .attr("stroke", d => getLinkColor((d.type || d.link_type || '').toLowerCase()))
                .attr("stroke-width", 4)
                .style("opacity", 0.12)
                .style("filter", "blur(3px)")
                .attr("display", d => (d.type || d.link_type || '').toLowerCase() === 'chronological' ? "none" : "block");

            // Main line
            g.append("line")
                .attr("class", "graph-link-main")
                .attr("stroke", d => getLinkColor((d.type || d.link_type || '').toLowerCase()))
                .attr("stroke-width", d => {
                    const type = (d.type || d.link_type || '').toLowerCase();
                    if (type === 'chronological') return 1;
                    if (type === 'semantic') {
                        const sim = d.similarity || 0;
                        return 1 + (sim * 2);
                    }
                    return 1.5;
                })
                .attr("stroke-dasharray", d => (d.type || d.link_type || '').toLowerCase() === 'chronological' ? "5,5" : "none")
                .attr("marker-end", d => {
                    const type = (d.type || d.link_type || '').toLowerCase();
                    if (type === 'semantic') return "url(#semantic-arrow)";
                    if (type === 'compensatory') return "url(#compensatory-arrow)";
                    if (type === 'contextual') return "url(#contextual-arrow)";
                    return "url(#chrono-arrow)";
                });

            // Link hover tooltip for lines
            g.append("line")
                .attr("class", "graph-link-hitbox")
                .attr("stroke", "transparent")
                .attr("stroke-width", 15) // Fat invisible line to catch hover events
                .on("mouseenter", (e, d) => {
                    const type = (d.type || d.link_type || '').toLowerCase();
                    if (type === 'semantic') {
                        tooltip.transition().duration(150).style("opacity", 1);
                        const simPct = (d.similarity || 0) * 100;
                        tooltip.html(`<div style="font-weight:600; color:#4dd9c0">Semantic chain — ${Math.round(simPct)}% match</div>`);
                        const tipNode = tooltip.node();
                        const w = tipNode.offsetWidth || 250;
                        tooltip.style("left", (e.pageX - w / 2) + "px").style("top", (e.pageY - tipNode.offsetHeight - 15) + "px");
                    }
                })
                .on("mousemove", (e, d) => {
                    const type = (d.type || d.link_type || '').toLowerCase();
                    if (type === 'semantic') {
                        const tipNode = tooltip.node();
                        const w = tipNode.offsetWidth || 250;
                        tooltip.style("left", (e.pageX - w / 2) + "px").style("top", (e.pageY - tipNode.offsetHeight - 15) + "px");
                    }
                })
                .on("mouseleave", (e, d) => {
                    const type = (d.type || d.link_type || '').toLowerCase();
                    if (type === 'semantic') {
                        tooltip.transition().duration(200).style("opacity", 0);
                    }
                });

        },
        update => update,
        exit => exit.remove()
    );

    // Propagate updated data to all child lines so D3 simulation updates their coordinates
    linkEnter.selectAll("line").datum(function() { return this.parentNode.__data__; });

    // Render Nodes
    const getNodeStroke = (d) => {
        const w = (d.wellness_label || d.wellness || "").toLowerCase();
        if (w.includes("positive")) return '#4db87a';
        if (w.includes("negative")) return '#c86060';
        return '#8888a8';
    };

    const node = nodeGroup.selectAll("g.node-group")
        .data(state.graphData.nodes, d => d.id);

    // Calculate chronological order: sort nodes by date
    const sortedNodes = [...state.graphData.nodes].sort((a, b) => new Date(a.date || a.timestamp) - new Date(b.date || b.timestamp));
    const nodeOrderMap = new Map();
    sortedNodes.forEach((n, index) => {
        nodeOrderMap.set(n.id, index + 1);
    });

    const nodeEnter = node.join(
        enter => {
            const g = enter.append("g")
                .attr("class", "node-group")
                .on("mouseenter", (e, d) => {
                    tooltip.transition().duration(150).style("opacity", 1);
                    const preview = (d.automatic_thought || d.text || d.situation || "").substring(0, 100);
                    const tagsStr = (d.tags && d.tags.length) ? `<div>Tags: ${d.tags.join(', ')}</div>` : '';
                    const cdStr = (d.cognitive_drift > 0) ? `<div style="margin-top:6px; color:#f4a942">Loop similarity: ${Math.round(d.cognitive_drift * 100)}%</div>` : '';

                    tooltip.html(`
                        <div style="font-weight:600; margin-bottom:4px; color:var(--accent,#7c6af7)">${d.drift_label || d.entry_type || "Note"}</div>
                        <div style="margin-bottom:6px; color:#8888a8">${d.wellness_label || "Neutral"}</div>
                        <div style="line-height:1.4">${preview}...</div>
                        ${tagsStr}
                        ${cdStr}
                    `);
                    const tipNode = tooltip.node();
                    const w = tipNode.offsetWidth;
                    tooltip.style("left", (e.pageX - w / 2) + "px").style("top", (e.pageY - 120) + "px");

                    state.hoveredNode = d;
                    updateHoverState();
                })
                .on("mousemove", (e) => {
                    const tipNode = tooltip.node();
                    const w = tipNode.offsetWidth || 250;
                    tooltip.style("left", (e.pageX - w / 2) + "px").style("top", (e.pageY - tipNode.offsetHeight - 15) + "px");
                })
                .on("mouseleave", () => {
                    tooltip.transition().duration(200).style("opacity", 0);
                    state.hoveredNode = null;
                    updateHoverState();
                })
                .on("click", (e, d) => openNodeDetail(d));

            // Rumination Glow
            g.append("rect")
                .attr("class", "rumination-glow")
                .attr("width", 168)
                .attr("height", 80)
                .attr("rx", 12)
                .attr("x", -84)
                .attr("y", -40)
                .attr("fill", "none")
                .attr("stroke", "#f4a942")
                .attr("stroke-width", 2)
                .style("opacity", 0.4)
                .style("filter", "blur(4px)");

            // Main Card Body
            g.append("rect")
                .attr("class", "node-card")
                .attr("width", 160)
                .attr("height", 72)
                .attr("rx", 8)
                .attr("x", -80)
                .attr("y", -36)
                .attr("fill", "rgba(15, 15, 22, 0.92)")
                .attr("stroke-width", 1.5)
                .style("filter", "url(#card-shadow)");

            // Header Bar Target (Top rounded rect emulation via clip path later, or rect + straight bottom rect)
            g.append("rect")
                .attr("class", "node-header-bar")
                .attr("width", 160)
                .attr("height", 20)
                .attr("rx", 8)
                .attr("x", -80)
                .attr("y", -36);

            // Cover bottom radius of header bar to make top-only rounded corners
            g.append("rect")
                .attr("class", "node-header-bar-base")
                .attr("width", 160)
                .attr("height", 10)
                .attr("x", -80)
                .attr("y", -26);

            // Entry Type Text
            g.append("text")
                .attr("class", "node-type-label")
                .attr("x", -72)
                .attr("y", -23)
                .attr("fill", "#ffffff")
                .attr("font-size", "9px")
                .attr("font-family", "monospace")
                .attr("pointer-events", "none");

            // Date text
            g.append("text")
                .attr("class", "node-date")
                .attr("x", -70)
                .attr("y", -8)
                .attr("fill", "rgba(255,255,255,0.5)")
                .attr("font-size", "11px")
                .attr("font-family", "var(--font-mono, monospace)")
                .attr("pointer-events", "none");

            // Primary Tag / Drift logic
            g.append("text")
                .attr("class", "node-tag")
                .attr("x", -70)
                .attr("y", 12)
                .attr("fill", "rgba(255,255,255,0.75)")
                .attr("font-size", "10px")
                .attr("font-family", "monospace")
                .attr("pointer-events", "none");

            // Sequence Number (Top Right)
            g.append("text")
                .attr("class", "node-sequence")
                .attr("x", 76)  // top-right corner, 4px from edge (width is 160: -80 to +80)
                .attr("y", -26) // top-right corner, 4px from edge (height is 72: -36 to +36)
                .attr("text-anchor", "end")
                .attr("fill", "rgba(255,255,255,0.25)")
                .attr("font-size", "8px")
                .attr("font-family", "monospace")
                .attr("pointer-events", "none");

            return g;
        },
        update => update,
        exit => exit.remove()
    );

    // Apply specific attributes based on updated data
    nodeGroup.selectAll("g.node-group").each(function (d) {
        const el = d3.select(this);
        const isDiary = d.entry_type === "thought_diary";

        // Opacity handled by updateHoverState()
        el.style("transition", "opacity 0.3s ease");

        // Glow visibility
        el.select(".rumination-glow").attr("display", d.rumination_flag > 0 ? "block" : "none");

        // Card Border Stroke base on wellness
        el.select(".node-card").attr("stroke", getNodeStroke(d));

        // Header bars Colors
        const headerColor = isDiary ? "rgba(185,124,248,0.6)" : "rgba(124,106,247,0.6)";
        el.select(".node-header-bar").attr("fill", headerColor);
        el.select(".node-header-bar-base").attr("fill", headerColor);

        // Header Text
        el.select(".node-type-label").text(isDiary ? "◇ diary" : "freeform");

        // Date Texts
        const dt = d.timestamp || d.date || "";
        const formattedDate = dt ? new Date(dt).toLocaleDateString("en-GB", { month: 'short', day: 'numeric' }) : '';
        el.select(".node-date").text(formattedDate);

        // Tag label
        let tagStr = d.drift_label ? `* ${d.drift_label}` : "";
        if (d.tags && d.tags.length > 0) {
            tagStr = `# ${d.tags[0]}`;
            el.select(".node-tag").style("font-style", "normal");
        } else {
            el.select(".node-tag").style("font-style", "italic");
        }
        el.select(".node-tag").text(tagStr);

        // Sequence label
        const orderIndex = nodeOrderMap.get(d.id);
        el.select(".node-sequence").text(orderIndex ? orderIndex : "");
    });

    // Dynamic Hover State Applier
    function updateHoverState(duration = 150) {
        const queryAct = !!query;
        const linkWrapperSel = linkGroup.selectAll("g.link-wrapper");
        const nodeGroupSel = nodeGroup.selectAll("g.node-group");

        let t = null;
        if (duration > 0) t = d3.transition().duration(duration);

        // Apply to wrapper (main lines)
        (t ? linkWrapperSel.transition(t) : linkWrapperSel).style("opacity", d => {
            const type = (d.type || d.link_type || '').toLowerCase();
            const isActive = state.activeFilters.has(type);
            if (!isActive) return 0;

            if (queryAct && !d._highlighted) return 0.03;

            if (state.hoveredNode) {
                const isConnected = (d.source.id || d.source) === state.hoveredNode.id ||
                    (d.target.id || d.target) === state.hoveredNode.id;
                if (!isConnected) return 0.02; // Aggressively dim non-connected
            }

            if (type === 'chronological') return 0.4;
            return 0.7; // semantic, compensatory, contextual
        });

        // Apply glow isolation
        const linkGlowSel = linkWrapperSel.selectAll(".graph-link-glow");
        (t ? linkGlowSel.transition(t) : linkGlowSel).style("opacity", d => {
            const type = (d.type || d.link_type || '').toLowerCase();
            const isActive = state.activeFilters.has(type);
            if (!isActive || (queryAct && !d._highlighted)) return 0;
            return 0.12;
        });

        (t ? nodeGroupSel.transition(t) : nodeGroupSel).style("opacity", d => {
            if (queryAct && !d._highlighted) return 0.06;
            if (state.hoveredNode && state.hoveredNode.id !== d.id) {
                const isConnected = readyLinks.some(l =>
                    state.activeFilters.has((l.type || l.link_type || '').toLowerCase()) &&
                    ((l.source.id || l.source) === state.hoveredNode.id && (l.target.id || l.target) === d.id ||
                        (l.target.id || l.target) === state.hoveredNode.id && (l.source.id || l.source) === d.id)
                );
                return isConnected ? 1.0 : 0.06; // Match unhighlight opacity
            }
            return 1.0;
        });

        // Brighten stroke if highlighted
        nodeGroupSel.select(".node-card")
            .attr("stroke-width", d => (queryAct && d._highlighted) ? 2.5 : 1.5);
    }

    // Expose logic to toggle so we can pulse and transition instead of full re-render
    window.applyVisibilities = (duration = 300) => {
        updateHoverState(duration);
    };

    window.triggerNodePulse = (type) => {
        nodeGroup.selectAll("g.node-group").each(function (d) {
            // Only pulse if this node is an endpoint of an ACTIVE and HIGHLIGHTED link of the toggled type
            const isEndpoint = readyLinks.some(l => {
                return (l.type || l.link_type || '').toLowerCase() === type &&
                    l._highlighted &&
                    ((l.source.id || l.source) === d.id || (l.target.id || l.target) === d.id);
            });

            if (isEndpoint) {
                const el = d3.select(this);
                d._scale = 1.0;
                el.transition("pulse").duration(200)
                    .tween("scale", function () {
                        const nodeData = this.__data__;
                        const i = d3.interpolateNumber(1, 1.06);
                        return function (t) {
                            nodeData._scale = i(t);
                            el.attr("transform", `translate(${nodeData.x},${nodeData.y}) scale(${nodeData._scale})`);
                        };
                    })
                    .transition().duration(200)
                    .tween("scale", function () {
                        const nodeData = this.__data__;
                        const i = d3.interpolateNumber(1.06, 1);
                        return function (t) {
                            nodeData._scale = i(t);
                            el.attr("transform", `translate(${nodeData.x},${nodeData.y}) scale(${nodeData._scale})`);
                        };
                    });
            }
        });
    };

    // ----------------------------------------------------
    // TICKS & DRAG
    // ----------------------------------------------------
    function ticked() {
        linkGroup.selectAll("g.link-wrapper").selectAll("line")
            .attr("x1", d => d.source.x || 0)
            .attr("y1", d => d.source.y || 0)
            .attr("x2", d => d.target.x || 0)
            .attr("y2", d => d.target.y || 0);

        nodeGroup.selectAll("g.node-group")
            .attr("transform", d => `translate(${d.x},${d.y}) scale(${d._scale || 1})`);
    }

    // Drag setup
    const drag = d3.drag()
        .on("start", (event, d) => {
            if (!event.active) simulation.alphaTarget(0.3).restart();
            d.fx = d.x;
            d.fy = d.y;
        })
        .on("drag", (event, d) => {
            d.fx = event.x;
            d.fy = event.y;
        })
        .on("end", (event, d) => {
            if (!event.active) simulation.alphaTarget(0);
            d.fx = null;
            d.fy = null;
        });

    nodeEnter.call(drag);

    // Call it initially
    updateHoverState();
}

// TOGGLE FILTERS
document.querySelectorAll('.filter-chip').forEach(chip => {
    chip.addEventListener('click', (e) => {
        const type = chip.dataset.type;
        const isTurningOn = !state.activeFilters.has(type);

        if (!isTurningOn) {
            state.activeFilters.delete(type);
            chip.classList.remove('active');
            if (window.applyVisibilities) window.applyVisibilities(200); // fade out 200ms
        } else {
            state.activeFilters.add(type);
            chip.classList.add('active');
            if (window.applyVisibilities) window.applyVisibilities(300); // fade in 300ms
            if (window.triggerNodePulse) window.triggerNodePulse(type);
        }
        // renderGraph(); // Note: We don't re-render graph physics on pure filter toggle to avoid jerks, we just transition CSS opacity.
    });
});

// SEARCH INPUT
let searchTimeout;
document.getElementById('search-input').addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
        state.searchQuery = e.target.value;
        renderGraph(); // We still render on search to update data match highlighted attributes and layout properties
    }, 200);
});

document.addEventListener('keydown', e => {
    if (e.key === '/' && document.activeElement.tagName !== 'TEXTAREA'
        && document.activeElement.tagName !== 'INPUT') {
        e.preventDefault();
        document.getElementById('search-input').focus();
    }
});

// NODE CLICK -> DETAIL PANEL
function openNodeDetail(node) {
    const p = document.getElementById('node-detail');
    p.classList.add('open');

    const isDiary = node.entry_type === 'thought_diary';
    document.getElementById('detail-type-label').innerHTML = isDiary ? '📝 Evidence & Reframe Diary' : '📃 Freeform';
    document.getElementById('detail-title').innerText = (node.situation || node.text || node.automatic_thought || "Untitled").substring(0, 80) + ((node.situation && node.situation.length > 80) ? '...' : '');

    const dt = node.timestamp || node.date;
    document.getElementById('detail-date').innerText = dt ? new Date(dt).toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' }) : 'Unknown Date';
    document.getElementById('detail-drift-badge').innerText = node.drift_label || "None";
    document.getElementById('detail-wellness-badge').innerText = (node.wellness_label || node.wellness || "Neutral").replace(/\b\w/g, c => c.toUpperCase());

    const body = document.getElementById('detail-content-area');
    body.innerHTML = '';

    if (isDiary && node.details) {
        body.innerHTML = `
            <div class="data-section"><div class="data-label">Situation</div><div class="data-value">${node.situation || ''}</div></div>
            <div class="data-section"><div class="data-label">First Thought</div><div class="data-value">${node.automatic_thought || node.text || ''}</div></div>
            <div class="data-section"><div class="data-label">Belief (Before)</div><div class="data-value">${node.details.thought_belief_before || 0}%</div></div>
            <div class="data-section"><div class="data-label">Emotion</div><div class="data-value">${node.details.emotion || ''} — Intensity: ${node.details.emotion_intensity || 0}%</div></div>
            <div class="data-section"><div class="data-label">Evidence For</div><div class="data-value">${node.details.evidence_for || ''}</div></div>
            <div class="data-section"><div class="data-label">Evidence Against</div><div class="data-value">${node.details.evidence_against || ''}</div></div>
            <div class="data-section"><div class="data-label">Reframed Perspective</div><div class="data-value">${node.details.reframed_thought || ''}</div></div>
            <div class="data-section"><div class="data-label">Belief (After)</div><div class="data-value">${node.details.thought_belief_after || 0}%</div></div>
        `;
    } else {
        body.innerHTML = `<div class="data-section"><div class="data-label">Content</div><div class="data-value">${node.automatic_thought || node.text || ''}</div></div>`;
    }

    const tagsArea = document.getElementById('detail-tags-area');
    tagsArea.innerHTML = '';
    if (node.tags && node.tags.length) {
        tagsArea.innerHTML = `<div class="tags-container" style="margin-top:24px;">${node.tags.map(t => `<span class="notion-badge" style="display:inline-block; margin-right:8px; margin-bottom:8px;">${t}</span>`).join('')}</div>`;
    }

    const connectList = document.getElementById('detail-connections-list');
    connectList.innerHTML = '';

    const myLinks = state.graphData.links.filter(l =>
        (l.source.id || l.source) === node.id || (l.target.id || l.target) === node.id
    );

    myLinks.forEach(l => {
        const isSource = (l.source.id || l.source) === node.id;
        const linkedId = isSource ? (l.target.id || l.target) : (l.source.id || l.source);
        const linkedNode = state.graphData.nodes.find(n => n.id === linkedId);
        if (!linkedNode) return;

        let color = '#fff';
        const type = (l.type || l.link_type || '').toLowerCase();
        if (type === 'semantic') color = '#4dd9c0';
        if (type === 'compensatory') color = '#f4a942';
        if (type === 'contextual') color = '#7c6af7';

        const div = document.createElement('div');
        div.className = 'connect-item';
        div.innerHTML = `
            <div class="connect-meta"><span class="dot" style="background:${color}; width:8px; height:8px; display:inline-block; border-radius:50%"></span> ${type.toUpperCase()}</div>
            <div class="connect-text">"${(linkedNode.situation || linkedNode.text || linkedNode.automatic_thought || "").substring(0, 60)}..."</div>
        `;
        div.onclick = () => openNodeDetailById(linkedNode.id);
        connectList.appendChild(div);
    });
}

window.openNodeDetailById = function (id) {
    const node = state.graphData.nodes.find(n => n.id === id);
    if (node) openNodeDetail(node);
};

// FORM SUBMISSION (analyze Entry)
async function analyseEntry(payload) {
    document.getElementById('loading-overlay').classList.remove('hidden');
    document.getElementById('loading-label').innerText = "Analysing entry & generating connections...";

    try {
        const res = await fetch(`${API}/analyze_thought`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!res.ok) throw new Error("API failed");

        const data = await res.json();
        state.pendingEntry = payload;

        // Combine arrays
        state.pendingLinks = [];
        if (data.proposed_links) {
            ['semantic', 'compensatory', 'contextual'].forEach(type => {
                if (data.proposed_links[type]) {
                    data.proposed_links[type].forEach(l => {
                        state.pendingLinks.push({ ...l, link_type: type });
                    });
                }
            });
        }

        openHITLModal(data);
    } catch (err) {
        console.error(err);
        alert("Server error. Check local server is running.");
    } finally {
        document.getElementById('loading-overlay').classList.add('hidden');
    }
}

// HITL MODAL
function openHITLModal(analysis) {
    state.approvedLinks.clear();
    const modal = document.getElementById('hitl-modal');
    modal.classList.remove('hidden');

    const c = analysis.classification || {};
    const driftPct = c.cognitive_drift ? Math.round(c.cognitive_drift * 100) : 0;

    document.getElementById('hitl-classification').innerText =
        `${c.drift_label || 'Note'} | ${(c.wellness_label || 'Neutral')} | CD: ${driftPct}%`;

    const banner = document.getElementById('rumination-banner');
    if (analysis.rumination?.rumination_detected && !state.sessionInterventionShown) {
        banner.classList.remove('hidden');
        state.sessionInterventionShown = true;
        const prompts = [
            "What would you tell a close friend who was having these same thoughts?",
            "What is one small thing that felt okay today, even briefly?",
            "What would need to change for this to feel less heavy?",
            "Is there a part of this situation that is actually within your control?",
            "What has helped you through something similar before?"
        ];
        document.getElementById('rumination-prompt').placeholder = prompts[Math.floor(Math.random() * prompts.length)];
    } else {
        banner.classList.add('hidden');
    }

    const container = document.getElementById('hitl-links-list');
    container.innerHTML = '';

    document.getElementById('hitl-link-count').innerText = state.pendingLinks.length;

    if (state.pendingLinks.length === 0) {
        container.classList.add('hidden');
        document.getElementById('hitl-empty-state').classList.remove('hidden');
    } else {
        container.classList.remove('hidden');
        document.getElementById('hitl-empty-state').classList.add('hidden');

        state.pendingLinks.forEach((linkObj, index) => {
            const card = document.createElement('div');
            card.className = 'link-card';
            card.dataset.type = linkObj.link_type;

            card.innerHTML = `
                <div class="card-checkbox"></div>
                <div class="card-content">
                    <div class="link-meta">
                        <span class="link-badge ${linkObj.link_type}">${linkObj.link_type}</span>
                        <span class="link-sim">${Math.round(linkObj.similarity * 100)}% match</span>
                    </div>
                    <div class="link-preview">"${(linkObj.preview || '').substring(0, 80)}"</div>
                </div>
            `;

            card.onclick = () => toggleLinkCard(index, card);
            container.appendChild(card);
        });
    }
}

function toggleLinkCard(index, cardEl) {
    if (state.approvedLinks.has(index)) {
        state.approvedLinks.delete(index);
        cardEl.classList.remove('selected');
    } else {
        state.approvedLinks.add(index);
        cardEl.classList.add('selected');
    }
}

// SAVE ENTRY
document.getElementById('hitl-save-none').addEventListener('click', () => saveEntry([]));
document.getElementById('hitl-save-confirm').addEventListener('click', () => {
    const arr = Array.from(state.approvedLinks).map(i => {
        return {
            target_id: state.pendingLinks[i].target_id,
            link_type: state.pendingLinks[i].link_type,
            similarity: state.pendingLinks[i].similarity
        };
    });
    saveEntry(arr);
});

async function saveEntry(approvedLinksArr) {
    document.getElementById('loading-overlay').classList.remove('hidden');
    document.getElementById('loading-label').innerText = "Saving entry...";
    document.getElementById('hitl-modal').classList.add('hidden');

    const finalPayload = { ...state.pendingEntry, approved_links: approvedLinksArr };

    try {
        const res = await fetch(`${API}/save_thought`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(finalPayload)
        });
        if (!res.ok) throw new Error("Save API failed");

        clearForms();
        await loadGraph();
    } catch (err) {
        console.error(err);
        alert("Save failed");
    } finally {
        document.getElementById('loading-overlay').classList.add('hidden');
    }
}

function clearForms() {
    document.querySelectorAll('form').forEach(f => f.reset());
    state.freeformTags = [];
    state.diaryTags = [];
    renderTags(document.getElementById('ff-tags-container'), state.freeformTags, 'ff-tag-input', 'ff-tags-container');
    renderTags(document.getElementById('diary-tags-container'), state.diaryTags, 'diary-tag-input', 'diary-tags-container');

    document.querySelectorAll('input[type="range"]').forEach(r => {
        r.value = 50;
        // manually dispatch input if any listeners tied
        r.dispatchEvent(new Event('input'));
    });

    goToStep(1);
    state.pendingEntry = null;
    state.pendingLinks = [];
    state.approvedLinks.clear();
}

// FETCH GRAPH
async function loadGraph() {
    try {
        const res = await fetch(`${API}/get_graph_data`);
        if (res.ok) {
            state.graphData = await res.json();
            renderGraph();
        }
    } catch (err) {
        console.error("Graph fetch error", err);
    }
}

// WIZARD NAVIGATION
function goToStep(n) {
    state.currentDiaryStep = n;
    document.querySelectorAll('.wizard-step').forEach(s => s.classList.add('hidden'));
    const target = document.querySelector(`.wizard-step[data-step="${n}"]`);
    if (target) target.classList.remove('hidden');

    document.querySelectorAll('.step-dot').forEach((dot, idx) => {
        if (idx < n) dot.classList.add('active');
        else dot.classList.remove('active');
    });

    const backBtn = document.getElementById('diary-btn-back');
    if (backBtn) {
        if (n === 1) backBtn.classList.add('hidden');
        else backBtn.classList.remove('hidden');
    }

    const nextBtn = document.getElementById('diary-btn-next');
    if (nextBtn) {
        nextBtn.innerText = n === 6 ? "Analyse & Review Links →" : "Next →";
    }
}

// TAGS HANDLING
function setupTagInput(inputId, wrapId, tagsArray) {
    const inp = document.getElementById(inputId);
    const wrap = document.getElementById(wrapId);
    if (!inp || !wrap) return;

    inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            const val = inp.value.trim().replace(/^,+|,+$/g, '');
            if (val && !tagsArray.includes(val)) {
                tagsArray.push(val);
                renderTags(wrap, tagsArray, inputId, wrapId);
            }
            inp.value = '';
        } else if (e.key === 'Backspace' && inp.value === '' && tagsArray.length > 0) {
            tagsArray.pop();
            renderTags(wrap, tagsArray, inputId, wrapId);
        }
    });
}

function renderTags(wrap, tagsArray, inputId, wrapId) {
    wrap.innerHTML = '';
    tagsArray.forEach((tag, i) => {
        const span = document.createElement('span');
        span.className = 'tag-chip';
        span.innerHTML = `${tag} <button type="button">&times;</button>`;
        span.querySelector('button').onclick = () => {
            tagsArray.splice(i, 1);
            renderTags(wrap, tagsArray, inputId, wrapId);
        };
        wrap.appendChild(span);
    });
}

// BINDINGS
document.addEventListener("DOMContentLoaded", () => {

    document.querySelector('.graph-panel').addEventListener('click', (e) => {
        if (e.target.tagName === 'svg' || e.target.id === 'graph-svg') {
            document.getElementById('node-detail').classList.remove('open');
        }
    });

    document.getElementById('detail-close').onclick = () => document.getElementById('node-detail').classList.remove('open');
    document.getElementById('hitl-close').onclick = () => document.getElementById('hitl-modal').classList.add('hidden');

    document.querySelectorAll('.mode-btn').forEach(b => {
        b.onclick = () => {
            document.querySelectorAll('.mode-btn').forEach(x => x.classList.remove('active'));
            b.classList.add('active');
            if (b.dataset.mode === 'freeform') {
                document.getElementById('form-freeform').classList.remove('hidden');
                document.getElementById('form-diary').classList.add('hidden');
            } else {
                document.getElementById('form-freeform').classList.add('hidden');
                document.getElementById('form-diary').classList.remove('hidden');
                goToStep(1);
            }
        };
    });

    setupTagInput('ff-tag-input', 'ff-tags-container', state.freeformTags);
    setupTagInput('diary-tag-input', 'diary-tags-container', state.diaryTags);

    const backBtn = document.getElementById('diary-btn-back');
    if (backBtn) backBtn.onclick = () => goToStep(state.currentDiaryStep - 1);

    const nextBtn = document.getElementById('diary-btn-next');
    if (nextBtn) {
        nextBtn.onclick = () => {
            if (state.currentDiaryStep < 6) {
                goToStep(state.currentDiaryStep + 1);
            } else {
                submitDiaryEntry();
            }
        };
    }

    document.getElementById('form-freeform').onsubmit = (e) => {
        e.preventDefault();
        const text = document.getElementById('ff-text').value.trim();
        if (!text) return;
        analyseEntry({
            user_id: 1,
            entry_type: "free_form",
            automatic_thought: text,
            context_tags: state.freeformTags
        });
    };

    function submitDiaryEntry() {
        const sit = document.getElementById('diary-situation').value.trim();
        const tht = document.getElementById('diary-thought').value.trim();
        if (!sit || !tht) { alert("Situation and First Thought required."); return; }

        analyseEntry({
            user_id: 1,
            entry_type: "thought_diary",
            situation: sit,
            automatic_thought: tht,
            thought_belief_before: parseInt(document.getElementById('diary-belief-before').value || "50"),
            emotion: document.getElementById('diary-emotion').value.trim(),
            emotion_intensity: parseInt(document.getElementById('diary-intensity').value || "50"),
            evidence_for: document.getElementById('diary-evidence-for').value.trim(),
            evidence_against: document.getElementById('diary-evidence-against').value.trim(),
            reframed_thought: document.getElementById('diary-reframed').value.trim(),
            thought_belief_after: parseInt(document.getElementById('diary-belief-after').value || "50"),
            context_tags: state.diaryTags
        });
    }

    // Sliders label sync
    ['diary-belief-before', 'diary-intensity', 'diary-belief-after'].forEach(id => {
        const el = document.getElementById(id);
        const lab = document.getElementById(id === 'diary-belief-before' ? 'belief-before-val' :
            id === 'diary-intensity' ? 'intensity-val' : 'belief-after-val');
        if (el && lab) {
            el.addEventListener('input', e => lab.innerText = e.target.value);
        }
    });

    loadGraph();
});
