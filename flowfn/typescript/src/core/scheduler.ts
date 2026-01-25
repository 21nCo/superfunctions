import parser from 'cron-parser';

export interface ScheduleOptions {
    pattern?: string;
    timezone?: string;
    data?: any;
    startDate?: Date;
    endDate?: Date;
    limit?: number;
    every?: number; // ms
}

export class Scheduler {
    private tasks: Map<string, {
        pattern: string | ScheduleOptions;
        handler: Function;
        nextRun: number;
        timer?: NodeJS.Timeout;
        count: number;
        paused: boolean;
    }> = new Map();

    async schedule(name: string, pattern: string | ScheduleOptions, handler: Function): Promise<void> {
        await this.cancel(name);
        
        const options: ScheduleOptions = typeof pattern === 'string' ? { pattern } : pattern;
        const now = Date.now();
        let nextRun = 0;

        if (options.pattern) {
            const interval = parser.parseExpression(options.pattern, {
                currentDate: options.startDate || new Date(),
                tz: options.timezone
            });
            nextRun = interval.next().getTime();
        } else if (options.every) {
            nextRun = (options.startDate?.getTime() || now) + options.every;
        }

        this.tasks.set(name, {
            pattern,
            handler,
            nextRun,
            count: 0,
            paused: false
        });

        this.plan(name);
    }
    
    async repeat(name: string, options: any, handler: Function): Promise<void> {
        return this.schedule(name, options, handler);
    }

    private plan(name: string) {
        const task = this.tasks.get(name);
        if (!task || task.paused) return;

        const now = Date.now();
        const delay = Math.max(0, task.nextRun - now);

        if (task.timer) clearTimeout(task.timer);

        task.timer = setTimeout(async () => {
            if (task.paused) return;
            
            try {
                const options: ScheduleOptions = typeof task.pattern === 'string' ? { pattern: task.pattern } : task.pattern;
                await task.handler(options.data);
                task.count++;

                // Check limits
                if (options.limit && task.count >= options.limit) {
                    this.tasks.delete(name);
                    return;
                }

                // Plan next run
                if (options.pattern) {
                    const interval = parser.parseExpression(options.pattern, {
                        currentDate: new Date(),
                        tz: options.timezone
                    });
                    task.nextRun = interval.next().getTime();
                } else if (options.every) {
                    task.nextRun = Date.now() + options.every;
                }

                if (options.endDate && task.nextRun > options.endDate.getTime()) {
                    this.tasks.delete(name);
                    return;
                }

                this.plan(name);
            } catch (err) {
                console.error(`Scheduler task "${name}" failed:`, err);
                // Still plan next run? Usually yes.
                this.plan(name);
            }
        }, delay);
    }

    async list(): Promise<any[]> {
        return Array.from(this.tasks.entries()).map(([name, task]) => ({
            name,
            nextRun: new Date(task.nextRun),
            count: task.count,
            paused: task.paused
        }));
    }

    async cancel(name: string): Promise<void> {
        const task = this.tasks.get(name);
        if (task) {
            if (task.timer) clearTimeout(task.timer);
            this.tasks.delete(name);
        }
    }

    async pause(name: string): Promise<void> {
        const task = this.tasks.get(name);
        if (task) {
            task.paused = true;
            if (task.timer) clearTimeout(task.timer);
        }
    }

    async resume(name: string): Promise<void> {
        const task = this.tasks.get(name);
        if (task && task.paused) {
            task.paused = false;
            // Recalculate next run if it passed while paused?
            // For cron, we just find the next occurrence from now.
            const options: ScheduleOptions = typeof task.pattern === 'string' ? { pattern: task.pattern } : task.pattern;
            if (options.pattern) {
                const interval = parser.parseExpression(options.pattern, {
                    currentDate: new Date(),
                    tz: options.timezone
                });
                task.nextRun = interval.next().getTime();
            } else if (options.every) {
                task.nextRun = Date.now() + options.every;
            }
            this.plan(name);
        }
    }

    async close(): Promise<void> {
        for (const task of this.tasks.values()) {
            if (task.timer) clearTimeout(task.timer);
        }
        this.tasks.clear();
    }
}