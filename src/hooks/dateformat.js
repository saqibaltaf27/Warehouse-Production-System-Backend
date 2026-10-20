const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function formatDate(value) {
  if (!value) return "";
  const raw = value instanceof Date ? value.toISOString() : String(value);
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return "";
  const day = Number(match[3]);
  const month = MONTHS[Number(match[2]) - 1];
  if (!month) return "";
  return `${day} ${month} ${match[1]}`;
}

module.exports = { formatDate };
