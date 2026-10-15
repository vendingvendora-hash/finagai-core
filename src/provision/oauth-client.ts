/**
 * A WorkOS OAuth client (confidential) for one of Finagai's own web pages: the dashboard steps Julian follows, and the
 * client ID + secret prompt.
 *
 * WorkOS has two pages called "Applications": the sidebar's (AuthKit applications, whose "API keys" are NOT OAuth
 * client secrets) and Connect > Applications (OAuth clients). Only the second works here. The ID and the secret are
 * asked as a pair and the ID is kept only once WorkOS accepts the pair, so a client created in the wrong place can be
 * replaced without editing any file.
 */
import type { Log, Prompter } from "./io.js";
import { CLIENT_REJECTED } from "./providers/others.js";
import type { Secret } from "./secret.js";

export function workosOAuthAppSteps(name: string, redirectUri: string): string[] {
  return [
    `Connect > Applications > Create application > OAuth application, named "${name}". Not the sidebar's "Applications" page: those are AuthKit applications and their API keys are not OAuth client secrets.`,
    "First-party, confidential (not public).",
    `Redirect URI: ${redirectUri}`,
    "Generate a client secret; keep the page open for the next two prompts.",
  ];
}

class ClientRejected extends Error {}

/** Ask for the client ID and its secret until WorkOS accepts the pair. `stored` is a previously saved ID (tried first). */
export async function askOAuthClient(prompt: Prompter, log: Log, opts: { idKey: string; secretKey: string; stored?: string | undefined;
  probe: (clientId: string, secret: Secret) => Promise<string | null> }): Promise<{ clientId: string; secret: Secret }> {
  let id = opts.stored;
  for (;;) {
    if (!id) {
      const v = (await prompt.ask(opts.idKey, "Its client ID (client_...):")).trim();
      if (!/^client_[A-Za-z0-9]+$/.test(v)) { log("  That is not a WorkOS client ID (client_...)."); continue; }
      id = v;
    }
    const clientId = id;
    try {
      const secret = await prompt.askSecret(opts.secretKey, "Its client secret", async (s) => {
        const problem = await opts.probe(clientId, s);
        if (problem === CLIENT_REJECTED) throw new ClientRejected(problem);
        return problem;
      });
      return { clientId, secret };
    } catch (e) {
      if (!(e instanceof ClientRejected)) throw e;
      log(`  WorkOS rejected ${clientId} with that secret. Check that the application is under Connect > Applications (OAuth, confidential), then enter its client ID again.`);
      id = undefined;
    }
  }
}
