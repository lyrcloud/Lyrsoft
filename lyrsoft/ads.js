// Lyrsoft Ad revenue (#/w/<ws>/ads), plugged into app.js above SEO. Earning from ads shown on the
// workspace's own websites (Google AdSense) and apps (Google AdMob), as opposed to Ads & budget, which
// tracks money spent on advertising. Placeholder until the AdSense and AdMob accounts are connected.

const SERVICES = [
  {
    icon: '🌐',
    name: 'Google AdSense',
    what: 'Ads on your websites',
    points: ['Connect a publisher account (ca-pub-…)', 'Choose which sites and pages show ads', 'Earnings, page views and RPM per site'],
  },
  {
    icon: '📱',
    name: 'Google AdMob',
    what: 'Ads in your phone apps',
    points: ['Connect an AdMob app and its ad units', 'Banner, interstitial and rewarded ads', 'Earnings, impressions and eCPM per app'],
  },
];

export function createAds({ esc }) {
  function view() {
    return `<div class="ads">
      <div class="page-head"><div><h1>Ad revenue</h1><p>Earn from ads on your own websites and apps. Spending on ads stays in Ads &amp; budget.</p></div>
        <div class="row"><span class="badge warn">Coming soon</span></div></div>
      <div class="ads-grid">${SERVICES.map(
        (s) => `<section class="card ads-card">
          <h2><span aria-hidden="true">${s.icon}</span> ${esc(s.name)}</h2>
          <p class="muted">${esc(s.what)}</p>
          <ul>${s.points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
          <button class="btn" disabled>Connect (coming soon)</button>
        </section>`,
      ).join('')}</div></div>`;
  }
  return { view };
}
