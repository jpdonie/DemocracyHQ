/**
 * The site inside another page (`?embed=1` before the `#`): the same views, and a link that opens the view the
 * reader is on at the full site.
 */
import { expect, heading, open, test } from './fixtures';

test.describe('The embedded form', () => {
  test('keeps the view, and its link out follows the reader from view to view', async ({ page }) => {
    await page.goto('?embed=1#/place/state:06');
    await expect(heading(page)).toHaveText('California');
    const out = page.getByRole('link', { name: 'Open DemocracyHQ in a new tab' });
    await expect(out).toBeVisible();
    await expect(out).toHaveAttribute('target', '_blank');
    await expect(out).toHaveAttribute('href', /#\/place\/state:06$/);
    expect(await out.getAttribute('href')).not.toContain('embed');
    // The pages a frame has no room for give way to the link out.
    await expect(page.getByRole('navigation', { name: 'About this site' }).getByRole('link', { name: 'Watchlist' })).toHaveCount(0);

    // "embed" stands before the #, so it stays while the reader moves on, and the link out moves with them.
    await page.getByRole('navigation', { name: 'Modules' }).getByRole('link', { name: 'Litigation' }).click();
    await expect(heading(page)).toHaveText('Election litigation');
    await expect(page).toHaveURL(/\?embed=1#\/litigation$/);
    await expect(out).toHaveAttribute('href', /#\/litigation$/);
  });

  test('the full site has no link out, and its About page gives the markup of a frame', async ({ page }) => {
    await open(page, '#/about');
    await expect(heading(page)).toHaveText(/About/);
    await expect(page.getByRole('link', { name: 'Open DemocracyHQ in a new tab' })).toHaveCount(0);
    const section = page.getByRole('region', { name: 'Embedding' });
    await expect(section).toContainText('?embed=1');
    await expect(section.locator('pre')).toContainText(/<iframe src="http[^"]+\?embed=1#\/" title="DemocracyHQ"/);
  });
});
