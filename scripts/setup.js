const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');

function askQuestion(rl, prompt) {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

async function promptMultiline(rl, prompt, hint) {
  console.log(prompt);
  if (hint) console.log(hint);
  const lines = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const line = await askQuestion(rl, '> ');
    if (!line.trim()) break;
    lines.push(line.trim());
  }
  return lines;
}

function parseYes(value) {
  if (!value) return false;
  return ['y', 'yes', 'true', '1'].includes(String(value).trim().toLowerCase());
}

function writeEnvFile(envPath, values) {
  const content = [
    `WEBHOOK_URL=${values.webhookUrl}`,
    `WEBHOOK_TOKEN=${values.webhookToken}`,
    `SEED_KEYWORDS=${values.seedKeywords.join('\\n')}`,
    `DISCOVERY_LIMIT=${values.discoveryLimit}`,
    `COUNTRIES=${values.countries}`,
    `COMPETITOR_URLS=${values.competitorUrls.join('\\n')}`,
    `RUN_HEADFUL=${values.runHeadful ? 'yes' : 'no'}`,
    `PAUSE_ON_LOGIN_WALL=${values.pauseOnLoginWall ? 'true' : 'false'}`
  ].join('\n');

  fs.writeFileSync(envPath, content, { encoding: 'utf8' });
}

function commandOk(cmd, args) {
  const res = spawnSync(cmd, args, { stdio: 'ignore' });
  return res.status === 0;
}

function gitRemote() {
  const res = spawnSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' });
  if (res.status !== 0) return null;
  return String(res.stdout || '').trim();
}

function setGhSecret(name, value) {
  if (value === undefined || value === null) return;

  if (name === 'COMPETITOR_URLS' || name === 'SEED_KEYWORDS') {
    const res = spawnSync('gh', ['secret', 'set', name, '-f', '-'], {
      input: value,
      encoding: 'utf8'
    });
    return res.status === 0;
  }

  const res = spawnSync('gh', ['secret', 'set', name, '-b', String(value)], {
    encoding: 'utf8'
  });
  return res.status === 0;
}

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  let webhookUrl = '';
  while (!webhookUrl) {
    const input = await askQuestion(rl, 'WEBHOOK_URL (must end with /exec): ');
    if (!input.trim()) continue;
    if (!input.trim().endsWith('/exec')) {
      console.log('The webhook URL must end with /exec. Please try again.');
      continue;
    }
    webhookUrl = input.trim();
  }

  let webhookToken = '';
  while (!webhookToken) {
    const input = await askQuestion(rl, 'WEBHOOK_TOKEN: ');
    if (!input.trim()) continue;
    webhookToken = input.trim();
  }

  const seedKeywords = await promptMultiline(
    rl,
    'SEED_KEYWORDS',
    'Paste one keyword or phrase per line. Submit an empty line to finish.'
  );

  const discoveryInput = await askQuestion(rl, 'DISCOVERY_LIMIT (default 30): ');
  const discoveryLimit = Number.parseInt(discoveryInput || '30', 10) || 30;

  const countriesInput = await askQuestion(rl, 'COUNTRIES (comma-separated, default ALL): ');
  const countries = (countriesInput || 'ALL').trim() || 'ALL';

  const competitorUrls = await promptMultiline(
    rl,
    'COMPETITOR_URLS (optional)',
    'Paste one URL per line (optional seeds). Submit an empty line to finish.'
  );

  const runHeadfulInput = await askQuestion(rl, 'RUN_HEADFUL? (yes/no, default no): ');
  const runHeadful = parseYes(runHeadfulInput);

  rl.close();

  if (seedKeywords.length === 0 && competitorUrls.length === 0) {
    console.log('You must provide at least one seed keyword or competitor URL. Exiting.');
    process.exit(1);
  }

  const envPath = path.join(process.cwd(), '.env');
  writeEnvFile(envPath, {
    webhookUrl,
    webhookToken,
    seedKeywords,
    discoveryLimit,
    countries,
    competitorUrls,
    runHeadful,
    pauseOnLoginWall: true
  });

  console.log(`\nWrote .env to ${envPath}`);

  const ghInstalled = commandOk('gh', ['--version']);
  const ghAuthed = ghInstalled && commandOk('gh', ['auth', 'status']);
  const gitOk = commandOk('git', ['rev-parse', '--is-inside-work-tree']);
  const origin = gitOk ? gitRemote() : null;

  if (ghInstalled && ghAuthed && origin) {
    console.log('Setting GitHub secrets via gh...');
    const okUrl = setGhSecret('WEBHOOK_URL', webhookUrl);
    const okToken = setGhSecret('WEBHOOK_TOKEN', webhookToken);
    const okSeeds = setGhSecret('SEED_KEYWORDS', seedKeywords.join('\n'));
    const okLimit = setGhSecret('DISCOVERY_LIMIT', discoveryLimit);
    const okCountries = setGhSecret('COUNTRIES', countries);
    const okCompetitors = setGhSecret('COMPETITOR_URLS', competitorUrls.join('\n'));
    const okPause = setGhSecret('PAUSE_ON_LOGIN_WALL', 'false');

    if (okUrl && okToken && okSeeds && okLimit && okCountries && okCompetitors && okPause) {
      console.log('GitHub secrets set successfully.');
    } else {
      console.log('GitHub secrets failed to set. You can rerun `npm run setup` after fixing gh auth or repo config.');
    }
  } else {
    console.log('\nSkipped GitHub secrets setup.');
    if (!ghInstalled) console.log('- gh CLI is not installed.');
    if (ghInstalled && !ghAuthed) console.log('- gh CLI is not authenticated. Run `gh auth login`.');
    if (!origin) console.log('- git remote origin is not set yet.');
    console.log('After git init/commit/push, rerun: npm run setup');
  }

  console.log('\nNext commands:');
  console.log('1) npm install');
  console.log('2) npm run scrape:local');
  console.log('3) git init');
  console.log('4) git add .');
  console.log('5) git commit -m "init"');
  console.log('6) git remote add origin <YOUR_REPO_URL>');
  console.log('7) git push -u origin main');
}

main().catch((err) => {
  console.error(`Setup failed: ${err.message}`);
  process.exit(1);
});
