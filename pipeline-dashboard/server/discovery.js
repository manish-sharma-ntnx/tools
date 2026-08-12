'use strict';

const { DISCOVERY_RULES } = require('./config');
const { listFolderJobs } = require('./jenkins');

/** Compare two ganges version strings (e.g. "7.6.0.1") numerically, desc-friendly. */
function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/** Group version string into its "train" (major.minor), e.g. 7.6.0.1 -> 7.6 */
function trainOf(version) {
  const parts = version.split('.');
  return parts.slice(0, 2).join('.');
}

/**
 * Discover all version-scoped pipelines across the configured rules.
 * Returns a structure keyed by version, each holding the matching jobs, plus a
 * separate list of "master" jobs (one per rule/lane).
 *
 * Shape:
 * {
 *   masters: [ { key, controller, path, lane, label, title, subtitle } ],
 *   versions: {
 *      "7.6": [ { key, controller, path, lane, version, label, title, subtitle } ]
 *   },
 *   discoveredAt, errors: []
 * }
 */
async function discoverPipelines() {
  const masters = [];
  const versions = {};
  const errors = [];

  for (const rule of DISCOVERY_RULES) {
    const res = await listFolderJobs(rule.controller, rule.parent);
    if (!res.ok) {
      errors.push({ rule: rule.id, error: res.error });
      continue;
    }

    // Master job for this lane (some lanes, e.g. Precommit PC, have none).
    const masterJob = rule.masterName
      ? res.jobs.find((j) => j.name === rule.masterName)
      : null;
    if (masterJob) {
      masters.push({
        key: `${rule.id}:master`,
        controller: rule.controller,
        path: [...rule.parent, rule.masterName],
        lane: rule.lane,
        ruleId: rule.id,
        masterGroup: rule.masterGroup || 'other',
        label: rule.label,
        title: `${rule.shortLabel} master`,
        subtitle: masterJob.name,
        version: 'master',
      });
    }

    // Version-scoped jobs.
    for (const job of res.jobs) {
      const m = rule.versionRegex.exec(job.name);
      if (!m) continue;
      const version = m[1];
      if (!versions[version]) versions[version] = [];
      versions[version].push({
        key: `${rule.id}:${version}`,
        controller: rule.controller,
        path: [...rule.parent, job.name],
        lane: rule.lane,
        ruleId: rule.id,
        masterGroup: rule.masterGroup || 'other',
        label: rule.label,
        title: `${rule.shortLabel} ${version}`,
        subtitle: job.name,
        version,
      });
    }

    // Synthesize a master card from the newest version when the lane has no real
    // master job (e.g. Precommit PC). Represents the "mainline" precommit status.
    if (rule.synthesizeMasterFromLatest) {
      const matched = res.jobs
        .map((j) => {
          const m = rule.versionRegex.exec(j.name);
          return m ? { name: j.name, version: m[1] } : null;
        })
        .filter(Boolean)
        .sort((a, b) => compareVersions(b.version, a.version));
      const newest = matched[0];
      if (newest) {
        masters.push({
          key: `${rule.id}:master`,
          controller: rule.controller,
          path: [...rule.parent, newest.name],
          lane: rule.lane,
          ruleId: rule.id,
          masterGroup: rule.masterGroup || 'other',
          label: rule.label,
          title: `${rule.shortLabel} (latest ${newest.version})`,
          subtitle: newest.name,
          version: 'master',
          synthesizedFrom: newest.version,
        });
      }
    }
  }

  return {
    masters,
    versions,
    trainOf,
    compareVersions,
    discoveredAt: Date.now(),
    errors,
  };
}

/** Sorted version keys, newest first. */
function sortedVersions(versionsObj) {
  return Object.keys(versionsObj).sort((a, b) => compareVersions(b, a));
}

module.exports = { discoverPipelines, compareVersions, trainOf, sortedVersions };
