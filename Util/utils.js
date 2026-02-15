export function manhattanDistance(x1, y1, x2, y2) { return Math.abs(x1 - x2) + Math.abs(y1 - y2); }
export function isSame(x1, y1, x2, y2) { return x1 === x2 && y1 === y2; }
export function tileKey(x, y) { return `${x},${y}`; }

