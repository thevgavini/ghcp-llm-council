function parseRanking(text) {
  if (typeof text !== 'string') return [];
  const marker = 'FINAL RANKING:';
  const idx = text.indexOf(marker);
  if (idx !== -1) {
    const section = text.slice(idx + marker.length);
    const numbered = section.match(/\d+\.\s*Response\s+[A-Z]/g);
    if (numbered && numbered.length) {
      return numbered.map((m) => m.match(/Response\s+[A-Z]/)[0].replace(/\s+/, ' '));
    }
  }
  const fallback = text.match(/Response\s+[A-Z]/g);
  if (!fallback) return [];
  return fallback.map((m) => m.replace(/\s+/, ' '));
}

function aggregate(ballots, labelToModel) {
  const positions = new Map();
  for (const ballot of ballots) {
    ballot.forEach((label, i) => {
      const model = labelToModel[label];
      if (!model) return;
      if (!positions.has(model)) positions.set(model, []);
      positions.get(model).push(i + 1);
    });
  }
  const rows = [];
  for (const [model, ps] of positions) {
    const avg = Math.round((ps.reduce((a, b) => a + b, 0) / ps.length) * 100) / 100;
    rows.push({ model, avg, votes: ps.length });
  }
  rows.sort((a, b) => a.avg - b.avg);
  return rows;
}

module.exports = { parseRanking, aggregate };
