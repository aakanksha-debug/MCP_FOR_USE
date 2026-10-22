export const metadata = { title: "Privacy | Incrementors Website Audit MCP" };

export default function Privacy() {
  return (
    <main>
      <h1>Privacy</h1>
      <p>
        <em>Draft for review by Incrementors before public launch.</em>
      </p>

      <h2>Website audits</h2>
      <p>
        When you ask Claude to audit a website, this service fetches publicly available pages of that website (plus
        robots.txt, sitemaps and llms.txt) to analyze them. Audit results are returned to your Claude conversation and are
        not stored by this service.
      </p>

      <h2>Google Search Console and Google Analytics (optional)</h2>
      <p>
        When you add the connector you can sign in with Google or continue without it, and you can also connect Google
        later in a conversation. If you choose to connect Google, you grant read-only access to Search Console and Google
        Analytics data. Access
        tokens are encrypted and stored for up to 30 days so Claude can query your data during your analysis. The data is
        used only to answer your requests and is not sold or shared. You can disconnect at any time by asking Claude to
        disconnect Google, or by revoking access at{" "}
        <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>.
      </p>
      <p>
        Use of information received from Google APIs adheres to the{" "}
        <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>,
        including the Limited Use requirements.
      </p>

      <h2>Contact</h2>
      <p>
        Questions: <a href="https://www.incrementors.com/contact-us/">incrementors.com/contact-us</a>
      </p>
    </main>
  );
}
