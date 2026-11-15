// Pure helpers for choosing which car represents a finished generation.
// Kept separate from world/ai.js so they can be unit-tested without a canvas.

// When a generation succeeded, the car worth evolving from is one that
// actually reached the target. Stop-credit and other bonuses can otherwise
// let a non-finisher outscore the car that completed the route.
function pickGenerationLeader(cars, success, scoreOf) {
    if (!cars || cars.length === 0) {
        return { leader: null, finishers: 0, arrived: false };
    }

    const finishers = cars.filter((car) => car.reachedTarget);
    const arrived = !!success && finishers.length > 0;
    const pool = arrived ? finishers : cars;

    return {
        leader: pool.reduce((a, b) => (scoreOf(b) > scoreOf(a) ? b : a)),
        finishers: finishers.length,
        arrived,
    };
}

// Keep a small hall of fame. Finishers outrank everyone, then score. On a tie
// the newer entry wins, so a plateau still gets fresh blood. An identical
// brain is refreshed in place instead of taking up a second slot.
function mergeElites(elites, candidate, limit) {
    const list = Array.isArray(elites) ? elites.slice() : [];
    if (candidate && candidate.brain) {
        const serialized = JSON.stringify(candidate.brain);
        const same = list.findIndex(
            (elite) => elite && elite.brain && JSON.stringify(elite.brain) === serialized
        );
        if (same === -1) {
            list.push(candidate);
        } else {
            list[same] = Object.assign({}, list[same], candidate);
        }
    }

    list.sort((a, b) => {
        const finished = (b.finished ? 1 : 0) - (a.finished ? 1 : 0);
        if (finished !== 0) return finished;
        if (b.score !== a.score) return b.score - a.score;
        return (b.generation || 0) - (a.generation || 0);
    });

    return list.slice(0, limit);
}
