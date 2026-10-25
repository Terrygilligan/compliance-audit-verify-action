#!/usr/bin/env node

/**
 * Sovereign Compliance Engine - Zero-Dependency CI Verification Runner
 * Implements "Inform aggressively, block conservatively" with posture-aware Level-A gating.
 */

import fs from 'node:fs';

const LEVEL_A_CRITERIA = new Set([
  '1.1.1', '1.2.1', '1.2.2', '1.2.3', '1.3.1', '1.3.2', '1.3.3',
  '1.4.1', '1.4.2', '2.1.1', '2.1.2', '2.1.4', '2.2.1', '2.2.2',
  '2.3.1', '2.4.1', '2.4.2', '2.4.3', '2.4.4', '2.5.1', '2.5.2',
  '2.5.3', '2.5.4', '3.1.1', '3.2.1', '3.2.2', '3.2.6', '3.3.1',
  '3.3.2', '4.1.1', '4.1.2'
]);

function getEnv(name, required = false, defaultValue = '') {
  const val = process.env[name];
  if (val !== undefined && val !== '') return val;
  if (required) {
    console.error(`::error::Missing required input/environment variable: ${name}`);
    process.exit(1);
  }
  return defaultValue;
}

async function request(url, options = {}) {
  const res = await fetch(url, options);
  let data = null;
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    data = await res.json();
  } else {
    data = await res.text();
  }
  return { status: res.status, headers: res.headers, data };
}

function escapeMarkdownTable(str) {
  if (!str) return '';
  return String(str).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

async function run() {
  const apiKey = getEnv('INPUT_API_KEY', true);
  const tenantId = getEnv('INPUT_TENANT_ID', true);
  const targetUrl = getEnv('INPUT_TARGET_URL', true);
  const region = getEnv('INPUT_REGION', false);
  const apiBase = getEnv('INPUT_API_BASE', false, 'https://api.compliance-audit.eu').replace(/\/$/, '');
  const tiersStr = getEnv('INPUT_TIERS', false, '1,2');
  const timeoutSec = parseInt(getEnv('INPUT_TIMEOUT_SECONDS', false, '600'), 10);
  const pollIntervalSec = parseInt(getEnv('INPUT_POLL_INTERVAL_SECONDS', false, '10'), 10);
  const failOn = getEnv('INPUT_FAIL_ON', false, 'level-a');
  const commentPr = getEnv('INPUT_COMMENT', false, 'true') === 'true';
  const githubToken = getEnv('GITHUB_TOKEN', false);
  const verifyChain = getEnv('INPUT_VERIFY_CHAIN', false, 'false') === 'true';
  const repo = getEnv('GITHUB_REPOSITORY', false, 'unknown/repo');
  const githubServerUrl = getEnv('GITHUB_SERVER_URL', false, 'https://github.com').replace(/\/$/, '');

  // Validate API base host
  try {
    const parsedUrl = new URL(apiBase);
    if (!parsedUrl.hostname.endsWith('compliance-audit.eu') && !parsedUrl.hostname.endsWith('compliance-audit.info')) {
      console.warn(`::warning::API base host '${parsedUrl.hostname}' does not match expected domain suffix.`);
    }
  } catch (err) {
    console.error(`::error::Invalid api-base URL: ${apiBase}`);
    process.exit(1);
  }

  const tiers = tiersStr.split(',').map(t => parseInt(t.trim(), 10)).filter(t => !isNaN(t));

  console.log(`[Compliance CI] Initiating audit scan for: ${targetUrl}`);
  console.log(`[Compliance CI] Target API: ${apiBase} (Tenant: ${tenantId}, Region: ${region || 'default'})`);

  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'x-tenant-id': tenantId,
    'Content-Type': 'application/json',
    'x-github-repository': repo
  };
  if (region) {
    headers['x-compliance-region'] = region;
  }

  // 1. POST /v1/audit
  const auditInitRes = await request(`${apiBase}/v1/audit`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ url: targetUrl, tiers })
  });

  if (auditInitRes.status !== 202) {
    console.error(`::error::Audit initialization failed with status ${auditInitRes.status}: ${JSON.stringify(auditInitRes.data)}`);
    process.exit(1);
  }

  const auditRunId = auditInitRes.data?.auditRunId;
  if (!auditRunId) {
    console.error(`::error::Server accepted audit request (202) but returned no auditRunId.`);
    process.exit(1);
  }

  console.log(`[Compliance CI] Audit enqueued successfully. Run ID: ${auditRunId}. Polling for completion...`);

  // 2. Poll GET /v1/audit/:id
  const startTime = Date.now();
  let finalAuditData = null;

  while (true) {
    const elapsedSec = (Date.now() - startTime) / 1000;
    if (elapsedSec > timeoutSec) {
      console.error(`::error::Audit timed out after ${timeoutSec} seconds.`);
      process.exit(1);
    }

    await new Promise(resolve => setTimeout(resolve, pollIntervalSec * 1000));

    const pollRes = await request(`${apiBase}/v1/audit/${auditRunId}`, {
      method: 'GET',
      headers
    });

    if (pollRes.status !== 200) {
      console.warn(`::warning::Poll returned status ${pollRes.status}, retrying...`);
      continue;
    }

    const body = pollRes.data;
    const status = body?.status;
    const progressPct = body?.progress?.percentage ?? 0;
    console.log(`[Compliance CI] Status: ${status} (Progress: ${progressPct}%)`);

    if (status === 'complete' || status === 'failed') {
      finalAuditData = body;
      break;
    }
  }

  if (!finalAuditData || finalAuditData.status === 'failed') {
    const errMsg = finalAuditData?.failureMessage || 'Unknown engine failure';
    const errCode = finalAuditData?.failureCode || 'EXECUTION_FAILED';
    console.error(`::error::Audit execution failed [${errCode}]: ${errMsg}`);
    process.exit(1);
  }

  // 3. Optional Proof-Chain Verification
  let chainVerification = null;
  if (verifyChain) {
    try {
      const verifyRes = await request(`${apiBase}/v1/tenants/${tenantId}/audit/verify`, {
        method: 'GET',
        headers
      });
      if (verifyRes.status === 200) {
        chainVerification = verifyRes.data;
      }
    } catch (e) {
      console.warn(`::warning::Proof-chain verification check failed: ${e.message}`);
    }
  }

  // 4. Conformance & Gating Analysis
  const conformanceRows = finalAuditData.conformance || [];
  const issues = finalAuditData.issues || [];

  let levelACriticalCount = 0;
  for (const row of conformanceRows) {
    if (row.level === 'A' && row.conformance === 'does_not_support') {
      levelACriticalCount++;
    }
  }

  // Fallback check on raw issues if conformance is empty
  if (conformanceRows.length === 0) {
    for (const issue of issues) {
      if (issue.severity === 'error') {
        const criteria = issue.wcagCriterion || [];
        if (criteria.some(c => LEVEL_A_CRITERIA.has(c))) {
          levelACriticalCount++;
        }
      }
    }
  }

  const counts = finalAuditData.counts || { errors: 0, warnings: 0, info: 0 };
  const totalErrors = counts.errors ?? issues.filter(i => i.severity === 'error').length;
  const totalWarnings = counts.warnings ?? issues.filter(i => i.severity === 'warning').length;

  // Determine verdict based on fail-on policy
  let shouldFail = false;
  if (failOn === 'level-a' && levelACriticalCount > 0) {
    shouldFail = true;
  } else if (failOn === 'any-error' && totalErrors > 0) {
    shouldFail = true;
  }

  const verdict = shouldFail ? 'failed' : 'success';

  // 5. Render Step Summary Markdown
  const mdLines = [
    `# Sovereign Compliance Audit Report`,
    ``,
    `| Metric | Value |`,
    `|---|---|`,
    `| **Target URL** | \`${targetUrl}\` |`,
    `| **Audit Run ID** | \`${auditRunId}\` |`,
    `| **Verdict** | **${verdict.toUpperCase()}** |`,
    `| **Level A Critical Defects** | ${levelACriticalCount} |`,
    `| **Total Errors / Warnings** | ${totalErrors} / ${totalWarnings} |`,
    ``
  ];

  if (chainVerification) {
    mdLines.push(
      `### Cryptographic Proof-Chain Status`,
      `- **Valid:** \`${chainVerification.valid}\``,
      `- **Entries:** \`${chainVerification.entries}\``,
      `- **Tip Hash:** \`${chainVerification.tipHash}\``,
      ``
    );
  }

  if (issues.length > 0) {
    mdLines.push(`### Detected Issues & Advisories`);
    mdLines.push(`| Severity | WCAG | Rule / Description | Element |`);
    mdLines.push(`|---|---|---|---|`);
    for (const issue of issues.slice(0, 25)) {
      mdLines.push(`| \`${issue.severity}\` | \`${escapeMarkdownTable((issue.wcagCriterion || []).join(', '))}\` | ${escapeMarkdownTable(issue.message)} | \`${escapeMarkdownTable(issue.elementSelector || 'N/A')}\` |`);
    }
    if (issues.length > 25) {
      mdLines.push(`*...and ${issues.length - 25} more issues. View full report in the portal.*`);
    }
    mdLines.push(``);
  }

  mdLines.push(`> *Inform aggressively, block conservatively.* Powered by compliance-audit.eu.`);

  const summaryMarkdown = mdLines.join('\n');
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.writeFileSync(process.env.GITHUB_STEP_SUMMARY, summaryMarkdown, { flag: 'a' });
  }

  // Set Actions Outputs
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `audit-run-id=${auditRunId}\n`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `verdict=${verdict}\n`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `errors=${totalErrors}\n`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `warnings=${totalWarnings}\n`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `level-a-failures=${levelACriticalCount}\n`);
  }

  // 6. PR Comment Upsert (Supporting GitHub Enterprise via GITHUB_SERVER_URL)
  let prNumber = null;
  try {
    const eventPayloadPath = process.env.GITHUB_EVENT_PATH;
    if (commentPr && githubToken && eventPayloadPath && fs.existsSync(eventPayloadPath)) {
      const eventData = JSON.parse(fs.readFileSync(eventPayloadPath, 'utf8'));
      prNumber = eventData.pull_request?.number;
    }
  } catch (e) {
    console.warn(`[Compliance CI] Could not parse PR event payload: ${e.message}`);
  }

  if (prNumber && githubToken) {
    console.log(`[Compliance CI] Upserting summary comment on Pull Request #${prNumber}...`);
    const commentBody = `<!-- compliance-verify -->\n${summaryMarkdown}`;
    const apiEndpointBase = githubServerUrl === 'https://github.com' ? 'https://api.github.com' : `${githubServerUrl}/api/v3`;
    const commentHeaders = {
      'Authorization': `Bearer ${githubToken}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'Sovereign-Compliance-Verify-Action'
    };

    try {
      const commentsRes = await request(`${apiEndpointBase}/repos/${repo}/issues/${prNumber}/comments`, {
        method: 'GET',
        headers: commentHeaders
      });

      if (commentsRes.status === 200 && Array.isArray(commentsRes.data)) {
        const existing = commentsRes.data.find(c => c.body && c.body.includes('<!-- compliance-verify -->'));
        if (existing) {
          await request(`${apiEndpointBase}/repos/${repo}/issues/comments/${existing.id}`, {
            method: 'PATCH',
            headers: commentHeaders,
            body: JSON.stringify({ body: commentBody })
          });
        } else {
          await request(`${apiEndpointBase}/repos/${repo}/issues/${prNumber}/comments`, {
            method: 'POST',
            headers: commentHeaders,
            body: JSON.stringify({ body: commentBody })
          });
        }
      }
    } catch (commentErr) {
      console.warn(`[Compliance CI] Failed to post PR comment (non-fatal): ${commentErr.message}`);
    }
  }

  // 7. Exit with Code
  if (shouldFail) {
    console.error(`::error::Compliance verification failed: Found ${levelACriticalCount} Level A critical failure(s) under policy '${failOn}'.`);
    process.exit(1);
  } else {
    console.log(`[Compliance CI] Compliance verification passed successfully.`);
    process.exit(0);
  }
}

run().catch(err => {
  console.error(`::error::Unhandled runner exception: ${err.message}`);
  process.exit(1);
});
