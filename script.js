// ── API Base URLs ─────────────────────────────────────────────────────────────────
const API      = "http://localhost:8001";
const AUTH_API = API; // Auth endpoints share the same server

// ── Theme System ──────────────────────────────────────────────────────────────────
(function initTheme() {
    const saved = localStorage.getItem('cc_theme') || 'dark';
    document.documentElement.setAttribute('data-theme', saved);
})();

function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('cc_theme', theme);

    const isDark = theme === 'dark';
    const moonIcon = document.querySelector('.theme-icon-dark');
    const sunIcon  = document.querySelector('.theme-icon-light');
    if (moonIcon) moonIcon.style.display = isDark ? 'block' : 'none';
    if (sunIcon)  sunIcon.style.display  = isDark ? 'none'  : 'block';

    // Update the SVG drop shadow so it's subtle in light mode
    const shadowEl = document.querySelector('#card-shadow feDropShadow');
    if (shadowEl) {
        shadowEl.setAttribute('flood-opacity', isDark ? '0.35' : '0.08');
        shadowEl.setAttribute('flood-color', isDark ? 'rgba(0,0,0,1)' : 'rgba(0,0,0,0.4)');
        shadowEl.setAttribute('stdDeviation', isDark ? '8' : '4');
    }

    // Redraw the D3 graph so node card fills pick up the new palette
    if (typeof renderGraph === 'function' && state.graphData.nodes.length) {
        renderGraph();
    }
}


// ── Session State ─────────────────────────────────────────────────────────────────
let sessionToken = null;


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
    hoveredNode: null,
    selectedNode: null  // tracks node whose detail panel is open (for Delete key)
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
    .attr("stdDeviation", 8)
    .attr("flood-opacity", 0.35)
    .attr("flood-color", "rgba(0,0,0,1)");

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

    // [DEBUG] Trace semantic link pipeline — remove when fixed
    console.log('[SEM] Total links:', baseLinks.length, '| types:', baseLinks.map(l => l.link_type || l.type));
    const semanticLinksRaw = baseLinks.filter(l => (l.type || l.link_type || '').toLowerCase() === 'semantic');
    console.log('[SEM] semanticLinksRaw:', semanticLinksRaw.length, semanticLinksRaw);
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
                    // Only remove if an INDIRECT path (2+ hops) exists through intermediate nodes.
                    // A direct chronological edge between the same pair is a different link type
                    // and does NOT make a semantic link redundant.
                    const path = this.findPath(sourceId, targetId);
                    if (path.length > 2) return false; // Indirect multi-hop path makes it redundant
                }
                return true;
            });
        }
    }

    const reducer = new TransitiveReducer(state.graphData.nodes, baseLinks);
    const reducedSemanticLinks = reducer.reduce(semanticLinksRaw, { minTemporalGap: 7 });

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
            d.cognitive_drift || "",
            d.wellness || ""
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
        .data(readyLinks, d => d.id || `${d.source.id || d.source}-${d.target.id || d.target}-${d.link_type || d.type}`);

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
                        <div style="font-weight:600; margin-bottom:4px; color:var(--accent,#7c6af7)">${d.cognitive_drift || d.entry_type || "Note"}</div>
                        <div style="margin-bottom:6px; color:#8888a8">${d.wellness || "Neutral"}</div>
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
        const isLight = document.documentElement.getAttribute('data-theme') === 'light';

        // Opacity handled by updateHoverState()
        el.style("transition", "opacity 0.3s ease");

        // Glow visibility
        el.select(".rumination-glow").attr("display", d.rumination_flag > 0 ? "block" : "none");

        // Card body fill — theme-aware
        const cardFill = isLight ? "rgba(255, 255, 255, 0.96)" : "rgba(15, 15, 22, 0.92)";
        el.select(".node-card").attr("fill", cardFill);

        // Card Border Stroke based on wellness
        el.select(".node-card").attr("stroke", getNodeStroke(d));

        // Header bars Colors
        const headerColor = isDiary ? "rgba(185,124,248,0.6)" : "rgba(124,106,247,0.6)";
        el.select(".node-header-bar").attr("fill", headerColor);
        el.select(".node-header-bar-base").attr("fill", headerColor);

        // Header Text — white on coloured header bar (both themes)
        el.select(".node-type-label").attr("fill", "#ffffff");

        // Date and tag text — theme-aware
        const dateColor   = isLight ? "rgba(30,30,60,0.55)"  : "rgba(255,255,255,0.5)";
        const tagColor    = isLight ? "rgba(30,30,60,0.75)"  : "rgba(255,255,255,0.75)";
        const seqColor    = isLight ? "rgba(30,30,60,0.25)"  : "rgba(255,255,255,0.25)";
        el.select(".node-date").attr("fill", dateColor);
        el.select(".node-tag").attr("fill", tagColor);
        el.select(".node-sequence").attr("fill", seqColor);

        // Date Texts
        const dt = d.timestamp || d.date || "";
        const formattedDate = dt ? new Date(dt).toLocaleDateString("en-GB", { month: 'short', day: 'numeric' }) : '';
        el.select(".node-date").text(formattedDate);

        // Tag label
        let tagStr = d.cognitive_drift ? `* ${d.cognitive_drift}` : "";
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

document.addEventListener('keydown', async e => {
    const activeTag = document.activeElement.tagName;
    const isTyping = activeTag === 'TEXTAREA' || activeTag === 'INPUT' || activeTag === 'SELECT';

    // '/' shortcut — focus search bar
    if (e.key === '/' && !isTyping) {
        e.preventDefault();
        document.getElementById('search-input').focus();
        return;
    }

    // Delete key — delete the currently selected (open) node
    if (e.key === 'Delete' && !isTyping && state.selectedNode) {
        const node = state.selectedNode;
        const label = (node.situation || node.automatic_thought || node.text || 'this node').substring(0, 60);
        const confirmed = window.confirm(
            `Delete this entry?\n\n"${label}"\n\nThis will permanently remove the node and all its connections. This cannot be undone.`
        );
        if (!confirmed) return;

        try {
            const res = await fetch(`${API}/nodes/${node.id}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${sessionToken}` }
            });

            if (res.status === 401) {
                sessionStorage.clear();
                sessionToken = null;
                showAuthOverlay();
                return;
            }

            if (res.ok) {
                // Close the detail panel and clear selection
                state.selectedNode = null;
                document.getElementById('node-detail').classList.remove('open');

                // Remove node and its links from local state
                state.graphData.nodes = state.graphData.nodes.filter(n => n.id !== node.id);
                state.graphData.links = state.graphData.links.filter(l => {
                    const src = typeof l.source === 'object' ? l.source.id : l.source;
                    const tgt = typeof l.target === 'object' ? l.target.id : l.target;
                    return src !== node.id && tgt !== node.id;
                });

                renderGraph();
                refreshGalleryAfterDelete(node.id);
            } else {
                const err = await res.json().catch(() => ({}));
                alert(`Could not delete node: ${err.detail || 'Unknown error'}`);
            }
        } catch (fetchErr) {
            alert('Delete failed — is the server running?');
            console.error('Delete error:', fetchErr);
        }
    }
});

// NODE CLICK -> DETAIL PANEL
function openNodeDetail(node) {
    state.selectedNode = node;
    const p = document.getElementById('node-detail');
    p.classList.add('open');

    const isDiary = node.entry_type === 'thought_diary';
    document.getElementById('detail-type-label').innerHTML = isDiary ? '📝 Evidence & Reframe Diary' : '📃 Freeform';
    document.getElementById('detail-title').innerText = (node.situation || node.text || node.automatic_thought || "Untitled").substring(0, 80) + ((node.situation && node.situation.length > 80) ? '...' : '');

    const dt = node.timestamp || node.date;
    document.getElementById('detail-date').innerText = dt ? new Date(dt).toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' }) : 'Unknown Date';
    document.getElementById('detail-drift-badge').innerText = node.cognitive_drift || "None";
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

// ── Local Passcode Authentication (4-screen flow) ──────────────────────────

let _resetToken = null; // held in memory between forgot-verify and reset

// ── Helpers ──────────────────────────────────────────────────────────────────

function showAuthScreen(screenId) {
    document.querySelectorAll('.auth-screen').forEach(s => s.classList.add('hidden'));
    document.getElementById(screenId).classList.remove('hidden');
}

function showAuthOverlay(screenId = 'auth-screen-login') {
    document.getElementById('auth-overlay').classList.remove('hidden');
    showAuthScreen(screenId);
    // Auto-focus first input in the active screen
    setTimeout(() => {
        const screen = document.getElementById(screenId);
        const first = screen && screen.querySelector('input, select');
        if (first) first.focus();
    }, 60);
}

function hideAuthOverlay() {
    document.getElementById('auth-overlay').classList.add('hidden');
}

function shakeCard() {
    const card = document.querySelector('.auth-card');
    card.style.animation = 'none';
    card.offsetHeight; // force reflow
    card.style.animation = 'shake 0.4s ease';
    setTimeout(() => card.style.animation = '', 450);
}

function setAuthBtnLoading(textId, spinnerId, loading) {
    document.getElementById(textId).classList.toggle('hidden', loading);
    document.getElementById(spinnerId).classList.toggle('hidden', !loading);
}

function showErr(errId, msg) {
    const el = document.getElementById(errId);
    el.textContent = msg;
    el.classList.remove('hidden');
}

function clearErr(errId) {
    document.getElementById(errId).classList.add('hidden');
}

// ── Startup ───────────────────────────────────────────────────────────────────

async function checkAuth() {
    // 1. Restore existing session token
    sessionToken = sessionStorage.getItem('session_token');
    if (sessionToken) {
        try {
            const res = await fetch(`${AUTH_API}/auth/check`, {
                headers: { 'Authorization': `Bearer ${sessionToken}` }
            });
            if (res.ok) {
                const data = await res.json();
                if (data.valid) { hideAuthOverlay(); return true; }
            }
        } catch (_) {}
        sessionStorage.removeItem('session_token');
        sessionToken = null;
    }

    // 2. Check registration status
    try {
        const res = await fetch(`${AUTH_API}/auth/status`);
        if (res.ok) {
            const data = await res.json();
            showAuthOverlay(data.registered ? 'auth-screen-login' : 'auth-screen-register');
            return false;
        }
    } catch (_) {}

    showAuthOverlay('auth-screen-login');
    return false;
}

// ── Screen wiring: navigation links ──────────────────────────────────────────

document.getElementById('go-forgot').addEventListener('click', async (e) => {
    e.preventDefault();
    clearErr('forgot-error');
    document.getElementById('forgot-question-text').textContent = 'Loading your security question…';
    showAuthScreen('auth-screen-forgot');
    document.getElementById('forgot-answer').value = '';

    try {
        const res = await fetch(`${AUTH_API}/auth/forgot/question`);
        if (res.ok) {
            const data = await res.json();
            document.getElementById('forgot-question-text').textContent = data.question;
        } else {
            document.getElementById('forgot-question-text').textContent = 'Could not load question. Please restart the app.';
        }
    } catch (_) {
        document.getElementById('forgot-question-text').textContent = 'Server not reachable.';
    }
});

document.getElementById('go-login-from-forgot').addEventListener('click', (e) => {
    e.preventDefault();
    showAuthScreen('auth-screen-login');
});

// ── Screen 2: REGISTER ───────────────────────────────────────────────────────

document.getElementById('register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErr('register-error');

    const passcode  = document.getElementById('reg-passcode').value;
    const confirm   = document.getElementById('reg-passcode-confirm').value;
    const question  = document.getElementById('reg-security-question').value;
    const answer    = document.getElementById('reg-security-answer').value.trim();

    if (passcode.length < 4)        { shakeCard(); return showErr('register-error', 'Passcode must be at least 4 characters.'); }
    if (passcode !== confirm)        { shakeCard(); return showErr('register-error', 'Passcodes do not match.'); }
    if (!question)                   { shakeCard(); return showErr('register-error', 'Please choose a security question.'); }
    if (!answer)                     { shakeCard(); return showErr('register-error', 'Security answer cannot be empty.'); }

    setAuthBtnLoading('register-btn-text', 'register-btn-spinner', true);
    try {
        const res = await fetch(`${AUTH_API}/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ passcode, security_question: question, security_answer: answer })
        });
        if (res.ok) {
            const data = await res.json();
            sessionToken = data.session_token;
            sessionStorage.setItem('session_token', sessionToken);
            sessionStorage.setItem('username', data.username);
            hideAuthOverlay();
            await loadGraph();
        } else {
            const err = await res.json().catch(() => ({}));
            shakeCard();
            showErr('register-error', err.detail || 'Registration failed.');
        }
    } catch (_) {
        shakeCard();
        showErr('register-error', 'Unable to connect. Make sure python app.py is running.');
    } finally {
        setAuthBtnLoading('register-btn-text', 'register-btn-spinner', false);
    }
});

// ── Screen 1: LOGIN ───────────────────────────────────────────────────────────

document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErr('login-error');

    const passcode = document.getElementById('login-passcode').value;
    setAuthBtnLoading('login-btn-text', 'login-btn-spinner', true);
    document.getElementById('login-passcode').disabled = true;

    try {
        const res = await fetch(`${AUTH_API}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ passcode })
        });
        if (res.ok) {
            const data = await res.json();
            sessionToken = data.session_token;
            sessionStorage.setItem('session_token', sessionToken);
            sessionStorage.setItem('username', data.username);
            hideAuthOverlay();
            await loadGraph();
            document.getElementById('login-passcode').value = '';
        } else {
            const err = await res.json().catch(() => ({}));
            shakeCard();
            showErr('login-error', err.detail || 'Incorrect passcode. Please try again.');
            document.getElementById('login-passcode').value = '';
            document.getElementById('login-passcode').focus();
        }
    } catch (_) {
        shakeCard();
        showErr('login-error', 'Unable to connect. Make sure python app.py is running.');
    } finally {
        setAuthBtnLoading('login-btn-text', 'login-btn-spinner', false);
        document.getElementById('login-passcode').disabled = false;
    }
});

// ── Screen 3: FORGOT — verify security answer ────────────────────────────────

document.getElementById('forgot-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErr('forgot-error');

    const answer = document.getElementById('forgot-answer').value.trim();
    if (!answer) { shakeCard(); return showErr('forgot-error', 'Please enter your answer.'); }

    setAuthBtnLoading('forgot-btn-text', 'forgot-btn-spinner', true);
    try {
        const res = await fetch(`${AUTH_API}/auth/forgot/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ security_answer: answer })
        });
        if (res.ok) {
            const data = await res.json();
            _resetToken = data.reset_token;
            showAuthScreen('auth-screen-reset');
            document.getElementById('reset-passcode').focus();
        } else {
            const err = await res.json().catch(() => ({}));
            shakeCard();
            showErr('forgot-error', err.detail || 'Incorrect answer. Please try again.');
            document.getElementById('forgot-answer').value = '';
        }
    } catch (_) {
        shakeCard();
        showErr('forgot-error', 'Unable to connect. Make sure python app.py is running.');
    } finally {
        setAuthBtnLoading('forgot-btn-text', 'forgot-btn-spinner', false);
    }
});

// ── Screen 4: RESET PASSCODE ─────────────────────────────────────────────────

document.getElementById('reset-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErr('reset-error');

    const passcode = document.getElementById('reset-passcode').value;
    const confirm  = document.getElementById('reset-passcode-confirm').value;

    if (passcode.length < 4)  { shakeCard(); return showErr('reset-error', 'Passcode must be at least 4 characters.'); }
    if (passcode !== confirm)  { shakeCard(); return showErr('reset-error', 'Passcodes do not match.'); }
    if (!_resetToken)          { shakeCard(); return showErr('reset-error', 'Reset session expired. Please start recovery again.'); }

    setAuthBtnLoading('reset-btn-text', 'reset-btn-spinner', true);
    try {
        const res = await fetch(`${AUTH_API}/auth/forgot/reset`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reset_token: _resetToken, new_passcode: passcode })
        });
        if (res.ok) {
            const data = await res.json();
            _resetToken = null;
            sessionToken = data.session_token;
            sessionStorage.setItem('session_token', sessionToken);
            sessionStorage.setItem('username', data.username);
            hideAuthOverlay();
            await loadGraph();
        } else {
            const err = await res.json().catch(() => ({}));
            shakeCard();
            showErr('reset-error', err.detail || 'Reset failed. Please try account recovery again.');
            _resetToken = null;
        }
    } catch (_) {
        shakeCard();
        showErr('reset-error', 'Unable to connect. Make sure python app.py is running.');
    } finally {
        setAuthBtnLoading('reset-btn-text', 'reset-btn-spinner', false);
    }
});

// ── Auto-logout: check session every 60 seconds ───────────────────────────────
setInterval(async () => {
    if (!sessionToken) return;
    try {
        const res = await fetch(`${AUTH_API}/auth/check`, {
            headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (res.ok) {
            const data = await res.json();
            if (!data.valid) {
                sessionStorage.clear();
                sessionToken = null;
                showAuthOverlay('auth-screen-login');
            }
        }
    } catch (_) { /* network error — ignore */ }
}, 60_000);


// FORM SUBMISSION (analyze Entry)
async function analyseEntry(payload) {
    document.getElementById('loading-overlay').classList.remove('hidden');
    document.getElementById('loading-label').innerText = "Analysing entry & generating connections...";

    try {
        const res = await fetch(`${API}/analyze_thought`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${sessionToken}`
            },
            body: JSON.stringify(payload)
        });

        if (res.status === 401) {
            sessionStorage.clear();
            sessionToken = null;
            showAuthOverlay();
            return;
        }

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
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${sessionToken}`
            },
            body: JSON.stringify(finalPayload)
        });

        if (res.status === 401) {
            sessionStorage.clear();
            sessionToken = null;
            showAuthOverlay();
            return;
        }

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
        const res = await fetch(`${API}/get_graph_data`, {
            headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (res.status === 401) {
            sessionStorage.clear();
            sessionToken = null;
            showAuthOverlay();
            return;
        }
        if (res.ok) {
            state.graphData = await res.json();
            renderGraph();
            if (currentView === 'gallery') renderGallery();
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

// ── GALLERY VIEW ─────────────────────────────────────────────────────────────

/**
 * Current view state — 'graph' or 'gallery'
 */
let currentView = 'graph';

/**
 * Renders the gallery view from state.graphData.nodes
 * Groups nodes by Month/Year, newest month first.
 * Each group has a collapsible header with a chevron arrow.
 */
function renderGallery() {
    const scroll = document.getElementById('gallery-scroll');
    const emptyState = document.getElementById('gallery-empty');

    // Clear all month groups (keep the empty state div)
    scroll.querySelectorAll('.month-group').forEach(el => el.remove());

    const nodes = state.graphData.nodes;
    if (!nodes || nodes.length === 0) {
        emptyState.classList.remove('hidden');
        return;
    }
    emptyState.classList.add('hidden');

    // Group nodes by "MMMM YYYY" label
    const monthMap = new Map(); // key: "2026-03" → { label: "March 2026", nodes: [] }

    nodes.forEach(node => {
        const dt = node.timestamp || node.date;
        const d = dt ? new Date(dt) : new Date();
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        const label = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
        if (!monthMap.has(key)) {
            monthMap.set(key, { label, nodes: [] });
        }
        monthMap.get(key).nodes.push(node);
    });

    // Sort month keys descending (newest first)
    const sortedKeys = Array.from(monthMap.keys()).sort((a, b) => b.localeCompare(a));

    sortedKeys.forEach(key => {
        const group = monthMap.get(key);
        // Sort nodes within each month newest-first
        group.nodes.sort((a, b) => {
            const da = new Date(a.timestamp || a.date || 0);
            const db = new Date(b.timestamp || b.date || 0);
            return db - da;
        });

        const groupEl = document.createElement('div');
        groupEl.className = 'month-group';
        groupEl.dataset.month = key;

        // Month header (clickable to toggle collapse)
        const header = document.createElement('div');
        header.className = 'month-group-header';
        header.innerHTML = `
            <svg class="month-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
            <span class="month-label">${group.label}</span>
            <span class="month-count-badge">${group.nodes.length} ${group.nodes.length === 1 ? 'entry' : 'entries'}</span>
        `;
        header.addEventListener('click', () => {
            groupEl.classList.toggle('collapsed');
        });

        // Cards grid
        const grid = document.createElement('div');
        grid.className = 'month-cards-grid';

        group.nodes.forEach(node => {
            const card = buildNoteCard(node);
            grid.appendChild(card);
        });

        groupEl.appendChild(header);
        groupEl.appendChild(grid);
        scroll.appendChild(groupEl);
    });
}

/**
 * Builds a single note card element for a node.
 */
function buildNoteCard(node) {
    const isDiary = node.entry_type === 'thought_diary';
    const card = document.createElement('div');
    card.className = `note-card ${isDiary ? 'entry-diary' : 'entry-freeform'}`;
    card.dataset.nodeId = node.id;

    const dt = node.timestamp || node.date;
    const formattedDate = dt ? new Date(dt).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric'
    }) : '';

    const title = (node.situation || node.automatic_thought || node.text || 'Untitled').substring(0, 120);
    const preview = (node.automatic_thought || node.text || node.situation || '').substring(0, 180);

    const wellness = (node.wellness_label || node.wellness || '').toLowerCase();
    let wellnessClass = 'neutral';
    if (wellness.includes('positive')) wellnessClass = 'positive';
    else if (wellness.includes('negative')) wellnessClass = 'negative';

    const tagsHtml = (node.tags && node.tags.length)
        ? node.tags.slice(0, 3).map(t => `<span class="note-card-tag">#${t}</span>`).join('')
        : '';

    card.innerHTML = `
        <div class="note-card-top">
            <span class="note-card-type">${isDiary ? '◇ diary' : 'freeform'}</span>
            <span class="note-card-date">${formattedDate}</span>
        </div>
        <div class="note-card-title">${title}</div>
        ${preview && preview !== title ? `<div class="note-card-preview">${preview}</div>` : ''}
        <div class="note-card-footer">
            <div class="note-card-tags">${tagsHtml}</div>
            <div class="note-wellness-dot ${wellnessClass}" title="${node.wellness_label || node.wellness || 'Neutral'}"></div>
        </div>
        <div class="note-card-delete-hint">select & press Delete</div>
    `;

    // Click → open the shared detail panel (same as graph)
    card.addEventListener('click', () => {
        openNodeDetail(node);
    });

    return card;
}

/**
 * Refreshes a single node card in the gallery after data changes,
 * or removes it if the node no longer exists.
 */
function refreshGalleryAfterDelete(deletedNodeId) {
    const card = document.querySelector(`.note-card[data-node-id="${deletedNodeId}"]`);
    if (!card) return;

    const grid = card.closest('.month-cards-grid');
    const groupEl = card.closest('.month-group');
    card.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
    card.style.opacity = '0';
    card.style.transform = 'scale(0.95)';

    setTimeout(() => {
        card.remove();

        // If the grid is now empty, remove the entire month group
        if (grid && grid.querySelectorAll('.note-card').length === 0) {
            groupEl && groupEl.remove();
        } else if (groupEl) {
            // Update the count badge
            const remaining = grid ? grid.querySelectorAll('.note-card').length : 0;
            const badge = groupEl.querySelector('.month-count-badge');
            if (badge) badge.textContent = `${remaining} ${remaining === 1 ? 'entry' : 'entries'}`;
        }

        // Show empty state if nothing left
        const scroll = document.getElementById('gallery-scroll');
        if (scroll && scroll.querySelectorAll('.month-group').length === 0) {
            const emptyState = document.getElementById('gallery-empty');
            if (emptyState) emptyState.classList.remove('hidden');
        }
    }, 300);
}

// ── VIEW TAB SWITCHING ────────────────────────────────────────────────────────

function switchView(view) {
    currentView = view;

    const graphPanel = document.getElementById('graph-panel');
    const galleryPanel = document.getElementById('gallery-panel');
    const entryPanel = document.getElementById('entry-panel');
    const commandCenter = document.getElementById('command-center');
    const tabGraph = document.getElementById('tab-graph');
    const tabGallery = document.getElementById('tab-gallery');

    if (view === 'gallery') {
        // Show gallery, hide graph
        graphPanel.classList.add('hidden');
        galleryPanel.classList.remove('hidden');

        // Entry panel stays visible in gallery too (for adding new nodes)
        // Command center can stay visible (search)
        tabGraph.classList.remove('active');
        tabGallery.classList.add('active');

        // Render gallery with current graph data
        renderGallery();
    } else {
        // Show graph, hide gallery
        graphPanel.classList.remove('hidden');
        galleryPanel.classList.add('hidden');

        tabGraph.classList.add('active');
        tabGallery.classList.remove('active');
    }
}

// ── BINDINGS
document.addEventListener("DOMContentLoaded", async () => {

    // 1. Check auth FIRST — only proceed to init app if authenticated
    const authed = await checkAuth();

    document.querySelector('.graph-panel').addEventListener('click', (e) => {
        if (e.target.tagName === 'svg' || e.target.id === 'graph-svg') {
            state.selectedNode = null;
            document.getElementById('node-detail').classList.remove('open');
        }
    });

    document.getElementById('detail-close').onclick = () => {
        state.selectedNode = null;
        document.getElementById('node-detail').classList.remove('open');
    };
    document.getElementById('hitl-close').onclick = () => document.getElementById('hitl-modal').classList.add('hidden');

    // ── View tab buttons
    document.querySelectorAll('.view-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            switchView(tab.dataset.view);
        });
    });

    // ── Theme toggle button
    const themeBtn = document.getElementById('theme-toggle');
    if (themeBtn) {
        // Sync icons to current theme (in case saved preference is light)
        const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
        applyTheme(currentTheme);

        themeBtn.addEventListener('click', () => {
            const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
            applyTheme(next);
        });
    }




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

    // Only load graph if already authenticated (checkAuth handles it on login success)
    if (authed) await loadGraph();
});
