import { scorePath } from './score';

const target = process.argv[2];
if (!target) {
  console.error('Usage: npm run eval:score -- evals/cases/<id> | evals/runs/<id>');
  process.exit(2);
}
const score = scorePath(target);
console.log(JSON.stringify(score, null, 2));
process.exit(score.passed ? 0 : 1);
