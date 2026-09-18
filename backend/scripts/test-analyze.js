const { analyzeEmail } = require('../services/aiService');

const sampleEmails = [
  {
    caseName: 'Case 1: Clear Meeting Invite',
    email: {
      subject: 'Team Sync Meeting - Project Status Review',
      sender: 'manager@company.com',
      body_preview: 'Hi team, let us meet for our weekly sync meeting at 3 PM tomorrow in Conference Room B or via Zoom. Please bring your slide updates.'
    }
  },
  {
    caseName: 'Case 2: Clear Deadline',
    email: {
      subject: 'Database Engineering Assignment 2 Submission Notice',
      sender: 'professor@college.edu',
      body_preview: 'Reminder to all students: Assignment 2 on Normalization and Query Optimization is due Friday 11:59 PM. Late submissions will receive a 10% penalty per day.'
    }
  },
  {
    caseName: 'Case 3: Clear Opportunity',
    email: {
      subject: 'Summer Internship Applications Now Open at TechCorp',
      sender: 'careers@techcorp.com',
      body_preview: 'We are excited to announce that applications for our 2027 Software Engineering Summer Internship are officially open! Apply before October 15th.'
    }
  },
  {
    caseName: 'Case 4: Generic / Newsletter Type',
    email: {
      subject: 'GitHub Newsletter: What is new in open source this month',
      sender: 'news@github.com',
      body_preview: 'Explore top trending repositories, community highlights, and open-source release notes for the month of September.'
    }
  },
  {
    caseName: 'Case 5: Messy & Ambiguous Email',
    email: {
      subject: 'Fwd: re: random note',
      sender: 'friend@gmail.com',
      body_preview: 'hey just checking in... maybe we should catch up sometime or whatever. no worries if busy. see ya.'
    }
  }
];

async function runModelComparison(modelName) {
  console.log(`\n===============================================================`);
  console.log(`🤖 TESTING MODEL: [${modelName.toUpperCase()}] with format: 'json' & placeholder validation guard`);
  console.log(`===============================================================`);

  for (let i = 0; i < sampleEmails.length; i++) {
    const { caseName, email } = sampleEmails[i];
    console.log(`\n📌 [${modelName}] [Test ${i + 1}/5] ${caseName}`);
    console.log(`   Subject: "${email.subject}"`);
    console.log(`   From:    ${email.sender}`);

    const start = Date.now();
    const result = await analyzeEmail(email, modelName);
    const duration = ((Date.now() - start) / 1000).toFixed(2);

    console.log(`   ⏱️ Duration: ${duration}s`);
    console.log('   📊 Result:');
    console.log(`      • event_type: "${result.event_type}"`);
    console.log(`      • priority:   "${result.priority}"`);
    console.log(`      • time:       ${result.time ? `"${result.time}"` : 'null'}`);
    console.log(`      • summary:    "${result.summary}"`);
    console.log('---------------------------------------------------------------');
  }
}

async function main() {
  const modelsToTest = [];

  // Check if model name passed via CLI argument or test tinyllama first
  const cliModel = process.argv[2];
  if (cliModel) {
    modelsToTest.push(cliModel);
  } else {
    modelsToTest.push('tinyllama');
  }

  for (const model of modelsToTest) {
    await runModelComparison(model);
  }
}

main();
