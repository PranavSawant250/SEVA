const fs = require('fs');

const content = fs.readFileSync('C:/Users/PRANAV/.gemini/antigravity/brain/003ec9cb-543e-4e2f-9790-f59810bdcd8f/.system_generated/tasks/task-2592.log', 'utf8');

const regex = /\[#(\d+)\] "([^"]+)"\r?\nExpected: ([^\r\n]+)[\s\S]*?Agent Reply: "([^"]*)"\r?\nTools Called: ([^\r\n]+)(?:\r?\nArgs: ([^\r\n]+))?\r?\nMutations: ([^\r\n]+)/g;

let match;
const parsed = [];
while ((match = regex.exec(content)) !== null) {
  parsed.push({
    num: parseInt(match[1], 10),
    message: match[2],
    expected: match[3],
    reply: match[4],
    tools: match[5],
    args: match[6] || '[]',
    mutations: match[7]
  });
}

console.log(`Parsed ${parsed.length} cases.`);
parsed.forEach(p => {
  console.log(`\n=== Case #${p.num} ===`);
  console.log(`Message: "${p.message}"`);
  console.log(`Expected: ${p.expected}`);
  console.log(`Agent Reply: "${p.reply}"`);
  console.log(`Tools Called: ${p.tools}`);
  console.log(`Args: ${p.args}`);
  console.log(`Mutations: ${p.mutations}`);
});

