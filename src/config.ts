/** Build-time configuration. Nothing here is secret: the site is static and has no credentials. */

export const APP_NAME = 'DemocracyHQ';
/** The site's one-line description. The home page headline says the same; index.html and package.json repeat it. */
export const POSITIONING = 'Election litigation, voting laws and district boundaries, linked to their sources.';

/**
 * Repository URL, set at build time (the Pages workflow passes the repository
 * it runs in). When it is not set, correction links explain how to report a
 * problem instead of pointing at a repository that may not exist.
 */
const rawRepo: unknown = import.meta.env.VITE_REPO_URL;
export const REPO_URL: string | null =
  typeof rawRepo === 'string' && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(rawRepo) ? rawRepo : null;

/**
 * Address of a pre-filled correction report. It opens the repository's "Data correction"
 * issue form (`.github/ISSUE_TEMPLATE/data-correction.yml`); the query keys below are that
 * form's field ids.
 */
export function correctionUrl(subject: string, pageUrl: string): string | null {
  if (!REPO_URL) return null;
  const params = new URLSearchParams({
    template: 'data-correction.yml',
    title: `Correction: ${subject}`,
    record: `${subject} (${pageUrl})`,
  });
  return `${REPO_URL}/issues/new?${params.toString()}`;
}
