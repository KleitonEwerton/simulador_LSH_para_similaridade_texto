document.addEventListener("DOMContentLoaded", () => {
  // --- Elementos da UI ---
  const dataInput = document.getElementById("data-input");
  const kShinglesInput = document.getElementById("k-shingles");
  const numHashesInput = document.getElementById("num-hashes");
  const numBandsInput = document.getElementById("num-bands");
  const similarityThresholdInput = document.getElementById(
    "similarity-threshold"
  );

  const kVal = document.getElementById("k-val");
  const hashesVal = document.getElementById("hashes-val");
  const bandsVal = document.getElementById("bands-val");
  const rowsPerBandText = document.getElementById("rows-per-band");
  const thresholdVal = document.getElementById("threshold-val");

  const processBtn = document.getElementById("process-btn");
  const resultsOutputDiv = document.getElementById("results-output");
  const svg = d3.select("#graph-svg");
  const graphContainer = document.getElementById("graph-container");
  const graphLegend = document.getElementById("graph-legend");

  let documents = [];
  let shinglesMap = [];
  let minhashSignatures = [];
  let lshIndex = null;
  let vocabulary = new Map();
  let simulation;

  const colors = {
    query: "#22c55e", // green-500
    neighbor: "#ef4444", // red-500
    candidate: "#60a5fa", // blue-400
    default: "#9ca3af", // gray-400
  };

  // --- Lógica de LSH (mesma de antes) ---
  const createShingles = (text, k) => {
    const shingles = new Set();
    if (text.length < k) {
      shingles.add(text);
      return shingles;
    }
    for (let i = 0; i <= text.length - k; i++) {
      shingles.add(text.substring(i, i + k));
    }
    return shingles;
  };
  const jaccardSimilarity = (setA, setB) => {
    const intersection = new Set([...setA].filter((x) => setB.has(x)));
    const union = new Set([...setA, ...setB]);
    return union.size === 0 ? 0 : intersection.size / union.size;
  };
  const createHashFunctions = (count) => {
    const funcs = [];
    const maxVal = 2 ** 32 - 1;
    for (let i = 0; i < count; i++) {
      const a = Math.floor(Math.random() * (maxVal - 1) + 1);
      const b = Math.floor(Math.random() * (maxVal - 1));
      funcs.push((x) => (a * x + b) % maxVal);
    }
    return funcs;
  };
  const createMinHashSignatures = (shingleSets, hashFunctions) => {
    const signatures = [];
    shingleSets.forEach((shingleSet) => {
      const signature = [];
      hashFunctions.forEach((hashFunc) => {
        let minHash = Infinity;
        shingleSet.forEach((shingle) => {
          const shingleId = vocabulary.get(shingle);
          const hashVal = hashFunc(shingleId);
          if (hashVal < minHash) {
            minHash = hashVal;
          }
        });
        signature.push(minHash);
      });
      signatures.push(signature);
    });
    return signatures;
  };
  const buildLSHIndex = (signatures, bands) => {
    const index = {};
    if (signatures.length === 0) return index;
    const rows = Math.floor(signatures[0].length / bands);
    if (rows === 0) return null;
    signatures.forEach((sig, docId) => {
      for (let b = 0; b < bands; b++) {
        const band = sig.slice(b * rows, (b + 1) * rows);
        const bandKey = `${b}_${band.join(",")}`;
        if (!index[bandKey]) {
          index[bandKey] = [];
        }
        index[bandKey].push(docId);
      }
    });
    return index;
  };
  const queryLSH = (queryDocId, signatures, lshIndex, bands) => {
    const candidates = new Set();
    const querySig = signatures[queryDocId];
    if (!querySig) return candidates;
    const rows = Math.floor(querySig.length / bands);
    if (rows === 0) return candidates;
    for (let b = 0; b < bands; b++) {
      const band = querySig.slice(b * rows, (b + 1) * rows);
      const bandKey = `${b}_${band.join(",")}`;
      if (lshIndex[bandKey]) {
        lshIndex[bandKey].forEach((docId) => {
          if (docId !== queryDocId) {
            candidates.add(docId);
          }
        });
      }
    }
    return candidates;
  };

  // --- Lógica de Visualização do Grafo ---
  function drawGraph(nodes, links) {
    const width = graphContainer.clientWidth;
    const height = graphContainer.clientHeight;
    svg.selectAll("*").remove();

    simulation = d3
      .forceSimulation(nodes)
      .force(
        "link",
        d3
          .forceLink(links)
          .id((d) => d.id)
          .distance(100)
          .strength((link) => link.value * 0.5)
      )
      .force("charge", d3.forceManyBody().strength(-200))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force("collide", d3.forceCollide().radius(25));

    const link = svg
      .append("g")
      .attr("stroke", "#999")
      .attr("stroke-opacity", 0.6)
      .selectAll("line")
      .data(links)
      .join("line")
      .attr("stroke-width", (d) => Math.sqrt(d.value) * 5);

    const node = svg
      .append("g")
      .attr("class", "nodes")
      .selectAll("g")
      .data(nodes)
      .enter()
      .append("g")
      .call(drag(simulation));

    node
      .append("circle")
      .attr("r", 8)
      .attr("fill", colors.default)
      .on("click", (event, d) => runQuery(d.id));

    node
      .append("text")
      .text((d) => d.name)
      .attr("x", 12)
      .attr("y", 4)
      .style("font-size", "11px")
      .style("pointer-events", "none");

    // *** MELHORIA PRINCIPAL: Mantém os nós dentro da caixa ***
    simulation.on("tick", () => {
      link
        .attr("x1", (d) => d.source.x)
        .attr("y1", (d) => d.source.y)
        .attr("x2", (d) => d.target.x)
        .attr("y2", (d) => d.target.y);

      node.attr("transform", (d) => {
        const radius = 12; // Buffer para o maior círculo (consulta)
        d.x = Math.max(radius, Math.min(width - radius, d.x));
        d.y = Math.max(radius, Math.min(height - radius, d.y));
        return `translate(${d.x}, ${d.y})`;
      });
    });
  }

  function drag(simulation) {
    function dragstarted(event, d) {
      if (!event.active) simulation.alphaTarget(0.3).restart();
      d.fx = d.x;
      d.fy = d.y;
    }
    function dragged(event, d) {
      d.fx = event.x;
      d.fy = event.y;
    }
    function dragended(event, d) {
      if (!event.active) simulation.alphaTarget(0);
      d.fx = null;
      d.fy = null;
    }
    return d3
      .drag()
      .on("start", dragstarted)
      .on("drag", dragged)
      .on("end", dragended);
  }

  // --- Processamento Principal ---
  function processAndVisualize() {
    vocabulary.clear();
    shinglesMap = [];
    minhashSignatures = [];
    documents = dataInput.value.split("\n").filter((s) => s.trim() !== "");
    const k = parseInt(kShinglesInput.value, 10);
    let shingleIdCounter = 0;
    documents.forEach((doc) => {
      const shingles = createShingles(doc, k);
      shinglesMap.push(shingles);
      shingles.forEach((shingle) => {
        if (!vocabulary.has(shingle)) {
          vocabulary.set(shingle, shingleIdCounter++);
        }
      });
    });
    const numHashes = parseInt(numHashesInput.value, 10);
    const hashFunctions = createHashFunctions(numHashes);
    minhashSignatures = createMinHashSignatures(shinglesMap, hashFunctions);
    const numBands = parseInt(numBandsInput.value, 10);
    lshIndex = buildLSHIndex(minhashSignatures, numBands);
    if (!lshIndex) {
      resultsOutputDiv.innerHTML = `<p class="text-red-500">Erro: número de hashes deve ser divisível pelo número de bandas.</p>`;
      svg.selectAll("*").remove();
      return;
    }
    const graphNodes = documents.map((doc, i) => ({ id: i, name: doc }));
    const graphLinks = [];
    const threshold = parseFloat(similarityThresholdInput.value);
    for (let i = 0; i < documents.length; i++) {
      for (let j = i + 1; j < documents.length; j++) {
        const sim = jaccardSimilarity(shinglesMap[i], shinglesMap[j]);
        if (sim >= threshold) {
          graphLinks.push({ source: i, target: j, value: sim });
        }
      }
    }
    drawGraph(graphNodes, graphLinks);
    resultsOutputDiv.innerHTML = `<p class="text-gray-500">Pronto! Clique em um nó do grafo para buscar similares.</p>`;
  }

  const runQuery = (queryId) => {
    resultsOutputDiv.innerHTML = "Buscando...";
    const queryDoc = documents[queryId];
    const queryShingles = shinglesMap[queryId];
    const numBands = parseInt(numBandsInput.value, 10);
    const candidates = queryLSH(queryId, minhashSignatures, lshIndex, numBands);
    const candidateIds = Array.from(candidates);
    const allSimilarities = [];
    documents.forEach((doc, docId) => {
      if (docId !== queryId) {
        const sim = jaccardSimilarity(queryShingles, shinglesMap[docId]);
        if (sim > 0) {
          allSimilarities.push({ id: docId, doc, sim });
        }
      }
    });
    allSimilarities.sort((a, b) => b.sim - a.sim);
    const trueNeighbors = allSimilarities.slice(0, 5).map((item) => item.id);

    // Highlight no grafo
    svg
      .selectAll("circle")
      .transition()
      .duration(300)
      .attr("r", 8)
      .attr("fill", colors.default);
    svg
      .selectAll("circle")
      .filter((d) => candidateIds.includes(d.id))
      .transition()
      .duration(300)
      .attr("r", 10)
      .attr("fill", colors.candidate);
    svg
      .selectAll("circle")
      .filter((d) => trueNeighbors.includes(d.id))
      .transition()
      .duration(300)
      .attr("r", 10)
      .attr("fill", colors.neighbor);
    svg
      .selectAll("circle")
      .filter((d) => d.id === queryId)
      .transition()
      .duration(300)
      .attr("r", 12)
      .attr("fill", colors.query);

    // Renderizar resultados textuais
    let html = `<h4 class="font-bold text-lg">Consulta: "<span style="color:${colors.query};">${queryDoc}</span>"</h4>`;
    html += `<div class="grid grid-cols-1 md:grid-cols-2 gap-6 mt-4">`;
    html += `<div><h5 class="font-semibold mb-2">Candidatos LSH (<span style="color:${colors.candidate};">${candidates.size}</span>):</h5><ul class="list-disc pl-5 space-y-1">`;
    if (candidates.size > 0) {
      candidateIds.forEach((docId) => {
        html += `<li><strong>${documents[docId]}</strong></li>`;
      });
    } else {
      html += `<li>Nenhum candidato.</li>`;
    }
    html += `</ul></div>`;
    html += `<div><h5 class="font-semibold mb-2">Similaridade Real (Top 5 <span style="color:${colors.neighbor};">Vermelho</span>):</h5><ul class="list-disc pl-5 space-y-1">`;
    if (allSimilarities.length > 0) {
      allSimilarities.slice(0, 5).forEach((item) => {
        html += `<li><strong>${item.doc}</strong> (Jaccard: ${item.sim.toFixed(
          3
        )})</li>`;
      });
    } else {
      html += `<li>Nenhum similar.</li>`;
    }
    html += `</ul></div></div>`;
    resultsOutputDiv.innerHTML = html;
  };

  // --- Event Handlers e Inicialização ---
  function setupUI() {
    processBtn.addEventListener("click", processAndVisualize);
    const updateParams = () => {
      kVal.textContent = kShinglesInput.value;
      hashesVal.textContent = numHashesInput.value;
      bandsVal.textContent = numBandsInput.value;
      thresholdVal.textContent = parseFloat(
        similarityThresholdInput.value
      ).toFixed(2);
      const rows = Math.floor(numHashesInput.value / numBandsInput.value);
      rowsPerBandText.textContent = rows > 0 ? rows : "Inválido";
    };
    [
      kShinglesInput,
      numHashesInput,
      numBandsInput,
      similarityThresholdInput,
    ].forEach((input) => {
      input.addEventListener("input", updateParams);
      if (input.id === "similarity-threshold") {
        input.addEventListener("change", processAndVisualize);
      }
    });

    graphLegend.innerHTML = `
                <div class="flex items-center"><div style="background-color:${colors.query}" class="w-3 h-3 rounded-full mr-2"></div>Consulta</div>
                <div class="flex items-center"><div style="background-color:${colors.neighbor}" class="w-3 h-3 rounded-full mr-2"></div>Vizinho Real</div>
                <div class="flex items-center"><div style="background-color:${colors.candidate}" class="w-3 h-3 rounded-full mr-2"></div>Candidato LSH</div>
                <div class="flex items-center"><div style="background-color:${colors.default}" class="w-3 h-3 rounded-full mr-2"></div>Padrão</div>
            `;

    updateParams();
    processAndVisualize();
  }

  setupUI();
});
