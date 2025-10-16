import { manhattanDistance } from './utils.js';

export class Pathfinding {
    constructor(environment) {
        this.environment = environment;
    }

    // A* pathfinding algorithm
    findPath(startX, startY, goalX, goalY) {
        if (!this.environment.isReachable(startX, startY)) {
            console.log(`Start position (${startX}, ${startY}) is not reachable!`);
            return null;
        }
    
        if (!this.environment.isReachable(goalX, goalY)) {
            console.log(`Goal position (${goalX}, ${goalY}) is not reachable!`);
            return null;
        }

        if (!this.environment.isReachable(startX, startY) || 
            !this.environment.isReachable(goalX, goalY)) {
            return null;
        }

        // Already at goal
        if (startX === goalX && startY === goalY) {
            return [];
        }

        const openSet = new PriorityQueue();
        const closedSet = new Set();
        const cameFrom = new Map();
        const gScore = new Map();
        const fScore = new Map();

        const startKey = this.posKey(startX, startY);
        const goalKey = this.posKey(goalX, goalY);

        gScore.set(startKey, 0);
        fScore.set(startKey, manhattanDistance(startX, startY, goalX, goalY));
        openSet.enqueue(startKey, fScore.get(startKey));

        while (!openSet.isEmpty()) {
            const currentKey = openSet.dequeue();
            
            if (currentKey === goalKey) {
                return this.reconstructPath(cameFrom, currentKey);
            }

            closedSet.add(currentKey);
            const [currentX, currentY] = this.parseKey(currentKey);

            const neighbors = this.environment.map[currentY][currentX].getNeighbors();

            for (const neighbor of neighbors) {
                const neighborKey = this.posKey(neighbor.x, neighbor.y);
                
                if (closedSet.has(neighborKey)) continue;

                const tentativeGScore = gScore.get(currentKey) + 1;

                if (!gScore.has(neighborKey) || tentativeGScore < gScore.get(neighborKey)) {
                    cameFrom.set(neighborKey, currentKey);
                    gScore.set(neighborKey, tentativeGScore);
                    fScore.set(neighborKey, 
                        tentativeGScore + manhattanDistance(neighbor.x, neighbor.y, goalX, goalY)
                    );
                    
                    if (!openSet.contains(neighborKey)) {
                        openSet.enqueue(neighborKey, fScore.get(neighborKey));
                    }
                }
            }
        }

        return null; // No path found
    }

    // Reconstruct path from came_from map
    reconstructPath(cameFrom, currentKey) {
        const path = [];
        let current = currentKey;

        while (cameFrom.has(current)) {
            const [x, y] = this.parseKey(current);
            path.unshift({ x, y });
            current = cameFrom.get(current);
        }

        return path;
    }

    // Convert path to action sequence
    pathToActions(path, currentX, currentY) {
        if (!path || path.length === 0) return [];

        const actions = [];
        let x = currentX;
        let y = currentY;

        for (const pos of path) {
            const dx = pos.x - x;
            const dy = pos.y - y;

            if (dx === 1) actions.push('right');
            else if (dx === -1) actions.push('left');
            else if (dy === 1) actions.push('up');
            else if (dy === -1) actions.push('down');

            x = pos.x;
            y = pos.y;
        }

        return actions;
    }

    // Get next action to reach goal
    getNextAction(currentX, currentY, goalX, goalY) {
        const path = this.findPath(currentX, currentY, goalX, goalY);
        if (!path || path.length === 0) return null;

        const actions = this.pathToActions(path, currentX, currentY);
        return actions.length > 0 ? actions[0] : null;
    }

    // Position key for maps
    posKey(x, y) {
        return `${x},${y}`;
    }

    // Parse position key
    parseKey(key) {
        return key.split(',').map(Number);
    }
}

// Priority Queue implementation for A*
class PriorityQueue {
    constructor() {
        this.elements = [];
    }

    enqueue(item, priority) {
        const element = { item, priority };
        let added = false;

        for (let i = 0; i < this.elements.length; i++) {
            if (element.priority < this.elements[i].priority) {
                this.elements.splice(i, 0, element);
                added = true;
                break;
            }
        }

        if (!added) {
            this.elements.push(element);
        }
    }

    dequeue() {
        return this.elements.shift().item;
    }

    isEmpty() {
        return this.elements.length === 0;
    }

    contains(item) {
        return this.elements.some(el => el.item === item);
    }
}