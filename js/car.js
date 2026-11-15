class Car {
    constructor(x, y, width, height, controlType, maxSpeed = 3, color = "blue", guided = false) {
        this.x = x;
        this.y = y;
        this.width = width;
        this.height = height;
        this.color = color;

        this.speed = 0;
        this.acceleration = 0.2;
        this.maxSpeed = maxSpeed;
        this.friction = 0.05;
        this.angle = 0;
        this.damaged = false;
        this.traveled = 0;

        this.useBrain = controlType === "AI";
        this.guided = guided;
        this.guidance = [0, 0, 0]; // [route bends left, route bends right, signal ahead]

        if (controlType !== "DUMMY") {
            this.sensor = new Sensor(this);
            // Guided cars get three extra inputs and a slightly bigger hidden layer
            const inputCount = this.sensor.rayCount + (guided ? 3 : 0);
            this.brain = new NeuralNetwork([inputCount, guided ? 10 : 6, 4]);
        }
        this.controls = new Controls(controlType);
        this.polygon = this.#createPolygon();
    }

    update(roadBorders, traffic) {
        if (!this.damaged) {
            this.#move();
            this.polygon = this.#createPolygon();
            this.damaged = this.#assessDamage(roadBorders, traffic);
        }
        if (this.sensor) {
            this.sensor.update(roadBorders, traffic);

            // Turn each reading into a number: 0 = nothing seen, close to 1 = very near
            const offsets = this.sensor.readings.map((s) =>
                s == null ? 0 : 1 - s.offset
            );
            const inputs = this.guided ? offsets.concat(this.guidance) : offsets;
            const outputs = NeuralNetwork.feedForward(inputs, this.brain);

            if (this.useBrain) {
                let forward = outputs[0];
                let left = outputs[1];
                let right = outputs[2];
                let reverse = outputs[3];

                if (this.guided) {
                    // The network can switch both directions on at once, which
                    // cancels any movement. Resolve the contradiction instead
                    // of leaving the car frozen.
                    if (forward && reverse) {
                        reverse = 0;
                    }
                    if (left && right) {
                        const hint = (this.guidance[1] || 0) - (this.guidance[0] || 0);
                        if (hint > 0) {
                            left = 0;
                        } else if (hint < 0) {
                            right = 0;
                        } else {
                            left = 0;
                            right = 0;
                        }
                    }
                }

                this.controls.forward = forward;
                this.controls.left = left;
                this.controls.right = right;
                this.controls.reverse = reverse;
            }
        }
    }

    #assessDamage(roadBorders, traffic) {
        for (let i = 0; i < roadBorders.length; i++) {
            if (polysIntersect(this.polygon, roadBorders[i])) {
                return true;
            }
        }
        for (let i = 0; i < traffic.length; i++) {
            if (polysIntersect(this.polygon, traffic[i].polygon)) {
                return true;
            }
        }
        return false;
    }

    #createPolygon() {
        const points = [];
        const rad = Math.hypot(this.width, this.height) / 2;
        const alpha = Math.atan2(this.width, this.height);

        points.push({
            x: this.x - Math.sin(this.angle - alpha) * rad,
            y: this.y - Math.cos(this.angle - alpha) * rad,
        });
        points.push({
            x: this.x - Math.sin(this.angle + alpha) * rad,
            y: this.y - Math.cos(this.angle + alpha) * rad,
        });
        points.push({
            x: this.x - Math.sin(Math.PI + this.angle - alpha) * rad,
            y: this.y - Math.cos(Math.PI + this.angle - alpha) * rad,
        });
        points.push({
            x: this.x - Math.sin(Math.PI + this.angle + alpha) * rad,
            y: this.y - Math.cos(Math.PI + this.angle + alpha) * rad,
        });
        return points;
    }

    #move() {
        if (this.controls.forward) {
            this.speed += this.acceleration;
        }
        if (this.controls.reverse) {
            this.speed -= this.acceleration;
        }

        if (this.speed > this.maxSpeed) {
            this.speed = this.maxSpeed;
        }
        if (this.speed < -this.maxSpeed / 2) {
            this.speed = -this.maxSpeed / 2;
        }

        if (this.speed > 0) {
            this.speed -= this.friction;
        }
        if (this.speed < 0) {
            this.speed += this.friction;
        }
        if (Math.abs(this.speed) < this.friction) {
            this.speed = 0;
        }

        if (this.speed !== 0) {
            const flip = this.speed > 0 ? 1 : -1;
            const steerRate = 0.03 * (Math.abs(this.speed) / this.maxSpeed);
            if (this.controls.left) {
                this.angle += steerRate * flip;
            }
            if (this.controls.right) {
                this.angle -= steerRate * flip;
            }
        }

        this.x -= Math.sin(this.angle) * this.speed;
        this.y -= Math.cos(this.angle) * this.speed;
        this.traveled += this.speed;
    }

    draw(ctx, drawSensor = false) {
        if (this.sensor && drawSensor) {
            this.sensor.draw(ctx);
        }

        ctx.fillStyle = this.damaged ? "gray" : this.color;
        ctx.beginPath();
        ctx.moveTo(this.polygon[0].x, this.polygon[0].y);
        for (let i = 1; i < this.polygon.length; i++) {
            ctx.lineTo(this.polygon[i].x, this.polygon[i].y);
        }
        ctx.fill();
    }
}