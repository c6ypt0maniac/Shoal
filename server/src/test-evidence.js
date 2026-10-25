// Keep the failure inventory as well as stack-trace context. A tail-only
// log can turn a multi-bug test file into a misleading single-bug prompt.
export function testEvidence(output, limit = 16000) {
  const text = String(output).replace(/\u001b\[[0-9;]*m/g, '');
  if (text.length <= limit) return text;
  const failures = [...new Set(text.split(/\r?\n/).map(s=>s.trim()).filter(s=>/^(?:[✖×]|not ok\b|FAIL(?:ED)?\b|(?:#\s*)?(?:tests|pass|fail|suites)\s+\d)/i.test(s)))];
  const inventory = failures.join('\n').slice(0, Math.floor(limit*.4));
  const room = limit-inventory.length-150;
  const head = Math.floor(room/2);
  return `Failure inventory:\n${inventory}\n\nStart of test output:\n${text.slice(0,head)}\n\n[Middle of output omitted; read the complete test file too.]\n\nEnd of test output:\n${text.slice(-Math.max(0,room-head))}`.slice(0,limit);
}
