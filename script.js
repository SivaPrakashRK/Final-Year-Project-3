const API = "http://localhost:8000";

const state = {
    graphData: { nodes: [], links: [] },
    activeFilters: new Set(['semantic', 'compensatory', 'contextual']),
    searchQuery: "",
    pendingEntry: null,
    pendingLinks: [],
    approvedLinks: new Set(),
    currentDiaryStep: 1, // using 1-based to match data-step in HTML
    diaryTags: [],
    freeformTags: [],
    sessionInterventionShown: false
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

// SIMULATION
let simulation;

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

    // Filter links
    const visibleLinks = state.graphData.links.filter(d => {
        const type = (d.type || d.link_type || 'chronological').toLowerCase();
        if (type === 'chronological') return true;
        return state.activeFilters.has(type);
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
            ...(d.tags || [])
        ].join(" ").toLowerCase();

        d._highlighted = strOpts.includes(query);
    });

    // Link highlight evaluation
    visibleLinks.forEach(l => {
        const sourceNode = typeof l.source === 'object' ? l.source : state.graphData.nodes.find(n => n.id === l.source);
        const targetNode = typeof l.target === 'object' ? l.target : state.graphData.nodes.find(n => n.id === l.target);

        if (!query) {
            l._highlighted = true;
        } else {
            l._highlighted = (sourceNode && sourceNode._highlighted) && (targetNode && targetNode._highlighted);
        }
    });

    // Force Simulation Setup
    if (!simulation) {
        simulation = d3.forceSimulation()
            .force("link", d3.forceLink().id(d => d.id))
            .force("charge", d3.forceManyBody().strength(-280).distanceMax(400))
            .force("center", d3.forceCenter(width / 2, height / 2))
            .force("collide", d3.forceCollide(40))
            .force("y", d3.forceY(height / 2).strength(0.04))
            .alphaDecay(0.025)
            .on("tick", ticked);
    }

    const sortedNodes = [...state.graphData.nodes].sort((a, b) => a.id - b.id);
    const totalNodes = sortedNodes.length || 1;

    simulation.nodes(state.graphData.nodes);
    simulation.force("link").links(visibleLinks)
        .distance(d => {
            const t = (d.type || d.link_type || '').toLowerCase();
            return t === 'chronological' ? 140 : 200;
        })
        .strength(d => {
            const t = (d.type || d.link_type || '').toLowerCase();
            return t === 'chronological' ? 0.9 : 0.3;
        });

    simulation.force("x", d3.forceX(d => {
        const index = sortedNodes.findIndex(n => n.id === d.id);
        return (index / totalNodes - 0.5) * width * 0.8 + width / 2;
    }).strength(0.15));

    simulation.alphaTarget(0.1).restart();
    setTimeout(() => simulation.alphaTarget(0), 300);

    // Render Links
    const getLinkColor = (t) => {
        if (t === 'semantic') return '#4dd9c0';
        if (t === 'compensatory') return '#f4a942';
        if (t === 'contextual') return '#7c6af7';
        return 'rgba(255,255,255,0.12)';
    };

    const link = linkGroup.selectAll("line")
        .data(visibleLinks, d => d.id || `${d.source.id || d.source}-${d.target.id || d.target}-${d.type}`);

    link.join(
        enter => enter.append("line")
            .attr("stroke", d => getLinkColor((d.type || d.link_type || '').toLowerCase()))
            .attr("stroke-width", d => (d.type || d.link_type) === 'chronological' ? 1.5 : 2)
            .attr("stroke-dasharray", d => (d.type || d.link_type) === 'chronological' ? "4,4" : "none"),
        update => update,
        exit => exit.remove()
    )
        .attr("opacity", d => (!query) ? (d._highlighted ? 0.8 : 0.15) : (d._highlighted ? 1.0 : 0.05));

    // Render Nodes
    const getNodeStroke = (d) => {
        const w = (d.wellness_label || d.wellness || "").toLowerCase();
        if (w.includes("positive")) return '#4db87a';
        if (w.includes("negative")) return '#c86060';
        return '#8888a8';
    };

    const node = nodeGroup.selectAll("g.node-group")
        .data(state.graphData.nodes, d => d.id);

    const nodeEnter = node.join(
        enter => {
            const g = enter.append("g")
                .attr("class", "node-group")
                .call(d3.drag()
                    .on("start", (e, d) => {
                        if (!e.active) simulation.alphaTarget(0.3).restart();
                        d.fx = d.x; d.fy = d.y;
                    })
                    .on("drag", (e, d) => {
                        d.fx = e.x; d.fy = e.y;
                    })
                    .on("end", (e, d) => {
                        if (!e.active) simulation.alphaTarget(0);
                        d.fx = null; d.fy = null;
                    })
                )
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
                })
                .on("mousemove", (e) => {
                    const tipNode = tooltip.node();
                    const w = tipNode.offsetWidth || 250;
                    tooltip.style("left", (e.pageX - w / 2) + "px").style("top", (e.pageY - tipNode.offsetHeight - 15) + "px");
                })
                .on("mouseleave", () => {
                    tooltip.transition().duration(200).style("opacity", 0);
                })
                .on("click", (e, d) => openNodeDetail(d));

            // Rumination Glow
            g.append("circle")
                .attr("class", "rumination-glow")
                .attr("r", 40)
                .attr("fill", "none")
                .attr("stroke", "rgba(244, 169, 66, 0.35)")
                .attr("stroke-width", 8);

            // Shape (Pill or Diamond)
            g.append("rect")
                .attr("class", "node-shape");

            // Text Label
            g.append("text")
                .attr("class", "node-label")
                .attr("text-anchor", "middle")
                .attr("fill", "#e8e8f0")
                .attr("font-size", "12px")
                .attr("font-weight", "500")
                .attr("pointer-events", "none");

            // Date Label
            g.append("text")
                .attr("class", "node-date")
                .attr("text-anchor", "middle")
                .attr("fill", "#8888a8")
                .attr("font-size", "10px")
                .attr("dy", "14px")
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

        // Opacity
        el.attr("opacity", (!query) ? 1.0 : (d._highlighted ? 1.0 : 0.15));

        // Glow visibility
        el.select(".rumination-glow").attr("display", d.rumination_flag > 0 ? "block" : "none");

        // Shape attributes
        const shape = el.select(".node-shape");
        shape.attr("fill", "rgba(24, 24, 31, 0.85)") // match surface-2 glass
            .attr("stroke", getNodeStroke(d))
            .attr("stroke-width", 2);

        if (isDiary) {
            // Diamond: 56x56, rx=6, rotated 45
            const shift = d.details ? ((d.details.thought_belief_after || 0) - (d.details.thought_belief_before || 0)) : 0;
            const bScale = 1 + Math.max(0, shift) / 100; // max 2x scale

            shape.attr("width", 56)
                .attr("height", 56)
                .attr("x", -28)
                .attr("y", -28)
                .attr("rx", 6)
                .attr("transform", `rotate(45) scale(${Math.min(bScale, 1.4)})`);
        } else {
            // Pill: 110x38, rx=19
            shape.attr("width", 110)
                .attr("height", 38)
                .attr("x", -55)
                .attr("y", -19)
                .attr("rx", 19)
                .attr("transform", "rotate(0) scale(1)");
        }

        // Texts
        const dt = d.timestamp || d.date || "";
        const formattedDate = dt ? new Date(dt).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '';

        el.select(".node-label").text((d.tags && d.tags.length) ? d.tags[0] : (isDiary ? "Diary" : "Note")).attr("dy", "2px");
        el.select(".node-date").text(formattedDate).attr("dy", "18px");
    });

    function ticked() {
        linkGroup.selectAll("line")
            .attr("x1", d => d.source.x)
            .attr("y1", d => d.source.y)
            .attr("x2", d => d.target.x)
            .attr("y2", d => d.target.y);

        nodeGroup.selectAll("g.node-group")
            .attr("transform", d => `translate(${d.x},${d.y})`);
    }
}

// TOGGLE FILTERS
document.querySelectorAll('.filter-chip').forEach(chip => {
    chip.addEventListener('click', (e) => {
        const type = chip.dataset.type;
        if (state.activeFilters.has(type)) {
            state.activeFilters.delete(type);
            chip.classList.remove('active');
        } else {
            state.activeFilters.add(type);
            chip.classList.add('active');
        }
        renderGraph();
    });
});

// SEARCH INPUT
let searchTimeout;
document.getElementById('search-input').addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
        state.searchQuery = e.target.value;
        renderGraph();
    }, 200);
});

// NODE CLICK -> DETAIL PANEL
function openNodeDetail(node) {
    const p = document.getElementById('node-detail');
    p.classList.add('open');

    document.getElementById('detail-type-label').innerText = node.entry_type === 'thought_diary' ? '◇ Thought Diary' : '○ Freeform Entry';
    document.getElementById('detail-title').innerText = (node.situation || node.text || node.automatic_thought || "").substring(0, 80) + '...';

    const dt = node.timestamp || node.date;
    document.getElementById('detail-date').innerText = dt ? new Date(dt).toLocaleDateString() : '';
    document.getElementById('detail-drift-badge').innerText = node.drift_label || "None";
    document.getElementById('detail-wellness-badge').innerText = (node.wellness_label || node.wellness || "Neutral").toUpperCase();

    const body = document.getElementById('detail-content-area');
    body.innerHTML = '';

    if (node.entry_type === 'thought_diary' && node.details) {
        body.innerHTML = `
            <div class="belief-shift-container">
                <div class="belief-header">
                    <span>Belief Shift</span>
                    <span class="belief-shift-val">${node.details.thought_belief_after - node.details.thought_belief_before}%</span>
                </div>
                <div class="shift-track">
                    <div class="shift-before" style="left: ${node.details.thought_belief_before}%"></div>
                    <div class="shift-after" style="left: ${node.details.thought_belief_after}%"></div>
                </div>
            </div>
            <div class="data-section"><span class="data-label">1. Situation</span><div class="data-value">${node.situation || ''}</div></div>
            <div class="data-section"><span class="data-label">2. First Thought</span><div class="data-value">${node.automatic_thought || node.text || ''}</div></div>
            <div class="data-section"><span class="data-label">3. Emotion</span><div class="data-value">${node.details.emotion || ''} (${node.details.emotion_intensity || 0}%)</div></div>
            <div class="data-section"><span class="data-label">4. Evidence For</span><div class="data-value">${node.details.evidence_for || ''}</div></div>
            <div class="data-section"><span class="data-label">5. Evidence Against</span><div class="data-value">${node.details.evidence_against || ''}</div></div>
            <div class="data-section"><span class="data-label">6. Balanced Perspective</span><div class="data-value">${node.details.reframed_thought || ''}</div></div>
        `;
    } else {
        body.innerHTML = `<div class="data-section"><span class="data-label">Entry</span><div class="data-value">${node.automatic_thought || node.text || ''}</div></div>`;
    }

    const tagsArea = document.getElementById('detail-tags-area');
    tagsArea.innerHTML = '';
    if (node.tags && node.tags.length) {
        tagsArea.innerHTML = `<div class="tags-container" style="margin-top:16px;">${node.tags.map(t => `<span class="tag-chip">${t}</span>`).join('')}</div>`;
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
        div.onclick = () => openNodeDetail(linkedNode);
        connectList.appendChild(div);
    });
}

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
