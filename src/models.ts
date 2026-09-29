export function catalogEntries(catalog) {
  const entries = [];
  for (const group of catalog?.groups ?? []) {
    for (const model of group.models ?? []) {
      entries.push({
        index: entries.length + 1,
        provider: group.id,
        providerName: group.name ?? group.id,
        model: model.id,
        modelName: model.name ?? model.id,
      });
    }
  }
  return entries;
}

export function resolveModel(input, entries) {
  const query = input.trim();
  if (!query) return { kind: 'invalid' };
  let candidates;
  if (/^[1-9]\d*$/.test(query)) {
    const index = Number(query);
    candidates = entries.filter((entry) => entry.index === index);
  } else if (query.includes('/')) {
    candidates = entries.filter((entry) => `${entry.provider}/${entry.model}` === query);
  } else {
    candidates = entries.filter((entry) => entry.model === query);
  }
  if (candidates.length === 1) return { kind: 'selected', entry: candidates[0] };
  return { kind: candidates.length > 1 ? 'ambiguous' : 'invalid', candidates };
}

/** Respect WeChat's single-message text limit without truncating model IDs. */
export function splitMessage(lines, maxLength = 1200) {
  const chunks = [];
  let current = '';
  for (const line of lines) {
    const parts = String(line).match(/[\s\S]{1,1100}/gu) ?? [''];
    for (const part of parts) {
      if (current && current.length + part.length + 1 > maxLength) {
        chunks.push(current);
        current = '';
      }
      current += (current ? '\n' : '') + part;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
