// sim/main.js -- browser bootstrap. Fixed-timestep loop, decoupled from render.
(function () {
    "use strict";

    const canvas = document.getElementById("simCanvas");
    function resize() {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
    }
    resize();
    window.addEventListener("resize", resize);

    const renderer = new SIM.Renderer(canvas);

    const hornSound = new Audio("dragon-studio-car-honk-386166.mp3");
    hornSound.preload = "auto";
    hornSound.volume = 0.6;
    let soundUnlocked = false;
    let hornWasOn = false;
    function unlockSound() {
        if (soundUnlocked) return;
        hornSound.play().then(() => {
            hornSound.pause();
            hornSound.currentTime = 0;
            soundUnlocked = true;
        }).catch(() => {});
    }
    window.addEventListener("pointerdown", unlockSound);
    window.addEventListener("keydown", unlockSound);

    let sim;
    let running = true;
    let timeScale = 1;
    let accumulator = 0;
    let last = performance.now();

    function reset() {
        sim = new SIM.Simulation(SIM.scene.createIntersectionScene());
        accumulator = 0;
        hornWasOn = false;
        window.simDebug = { sim, reset, step: () => sim.step() };
    }
    reset();

    document.getElementById("btnPause").addEventListener("click", (e) => {
        running = !running;
        e.target.textContent = running ? "Pause" : "Play";
    });
    document.getElementById("btnStep").addEventListener("click", () => {
        running = false;
        document.getElementById("btnPause").textContent = "Play";
        sim.step();
    });
    document.getElementById("btnReset").addEventListener("click", reset);
    document.getElementById("speed").addEventListener("input", (e) => {
        timeScale = Number(e.target.value);
        document.getElementById("speedLabel").textContent = timeScale + "x";
    });

    // Dynamic viewport: wheel to zoom around the cursor, drag to pan.
    canvas.addEventListener(
        "wheel",
        (e) => {
            e.preventDefault();
            renderer.zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX, e.clientY);
        },
        { passive: false }
    );
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    canvas.addEventListener("mousedown", (e) => {
        dragging = true;
        lastX = e.clientX;
        lastY = e.clientY;
    });
    window.addEventListener("mouseup", () => (dragging = false));
    window.addEventListener("mousemove", (e) => {
        if (!dragging) return;
        renderer.panBy(e.clientX - lastX, e.clientY - lastY);
        lastX = e.clientX;
        lastY = e.clientY;
    });

    function loop(now) {
        const elapsed = Math.min((now - last) / 1000, 0.1);
        last = now;
        if (running) {
            accumulator += elapsed * timeScale;
            let steps = 0;
            while (accumulator >= sim.dt && steps < 30) {
                sim.step();
                accumulator -= sim.dt;
                steps++;
            }
            if (steps === 30) accumulator = 0; // avoid spiral of death
        }
        const hornOn = !!(sim.lastCmd && sim.lastCmd.horn);
        if (hornOn && !hornWasOn && soundUnlocked) {
            hornSound.currentTime = 0;
            hornSound.play().catch(() => {});
        }
        hornWasOn = hornOn;
        renderer.render(sim);
        requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
})();
