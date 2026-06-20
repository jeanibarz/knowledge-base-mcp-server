import type { EvolutionDecision } from './types.js';

export function renderEvolutionMarkdown(decision: EvolutionDecision): string {
  const lines = [
    `# Evolution run ${decision.run_id}`,
    '',
    `Champion: \`${decision.champion}\``,
    `Winner: \`${decision.winner}\``,
    `Promoted: ${decision.promoted ? 'yes' : 'no'}`,
    `Objective: \`${decision.objective.metric_path}\` (${decision.objective.direction})`,
    '',
    '| Candidate | Verdict | Objective | Budget | Reasons |',
    '| --- | --- | ---: | --- | --- |',
  ];

  for (const candidate of decision.candidates) {
    const objective = candidate.objective === null
      ? 'n/a'
      : `${formatNumber(candidate.objective.current)} (${formatSigned(candidate.objective.improvement)} improvement)`;
    const budget = `${candidate.budget_summary.fail} fail, ${candidate.budget_summary.warn} warn`;
    const reasons = candidate.reasons.length ? candidate.reasons.join('; ') : 'qualified';
    lines.push([
      candidate.arm_id,
      candidate.qualifies ? 'QUALIFY' : 'HOLD',
      objective,
      budget,
      reasons,
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }

  lines.push('', 'Promotion is advisory: apply defaults or code changes through a normal reviewed PR.');
  return `${lines.join('\n')}\n`;
}

function formatNumber(value: number): string {
  return Number(value.toFixed(3)).toString();
}

function formatSigned(value: number): string {
  const rounded = formatNumber(value);
  return value >= 0 ? `+${rounded}` : rounded;
}
