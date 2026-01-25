import chalk from 'chalk';
import type { TestResult, TestRunSummary, Reporter } from '../types.js';

export class ConsoleReporter implements Reporter {
  private startTime: number = 0;

  onTestStart(): void {
    if (this.startTime === 0) {
      this.startTime = Date.now();
      console.log(chalk.bold('\nTestFn v0.1.0\n'));
    }
  }

  onTestComplete(result: TestResult): void {
    const icon = result.status === 'passed' ? chalk.green('✓') : chalk.red('✗');
    const duration = chalk.gray(`${result.duration}ms`);
    
    console.log(`${icon} ${result.id} - ${duration}`);
    
    if (result.error) {
      console.log(chalk.red(`  Error: ${result.error.message}`));
      if (result.error.stack) {
        console.log(chalk.gray(`  ${result.error.stack.split('\n')[0]}`));
      }
    }
  }

  onRunComplete(summary: TestRunSummary): void {
    const duration = ((Date.now() - this.startTime) / 1000).toFixed(2);
    
    console.log('\n' + chalk.gray('─'.repeat(60)));
    console.log(chalk.bold('Test Summary:'));
    console.log(`  Total:    ${summary.total}`);
    console.log(`  ${chalk.green('Passed')}: ${summary.passed}`);
    console.log(`  ${chalk.red('Failed')}:  ${summary.failed}`);
    console.log(`  ${chalk.yellow('Skipped')}: ${summary.skipped}`);
    console.log(`  Duration: ${duration}s`);
    
    if (summary.failed > 0) {
      console.log(chalk.red('\n✗ Tests failed'));
    } else {
      console.log(chalk.green('\n✓ All tests passed'));
    }
  }
}
