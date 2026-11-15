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
