// Stand-ins for the passcode check and the clock, so every lock outcome can be tested without a phone.

import { Fx } from './support.mjs';

/**
 * Answers from a script. It can also run code "while the check is running" to simulate things happening meanwhile
 * (the app being sent to the background, a second tap).
 */
export class ScriptedAuthenticator {
  constructor(outcomes) {
    this.outcomes = [...outcomes];
    this.available = true;
    /** Runs after the check starts and before its result is returned. */
    this.whilePromptIsShowing = null;
    this.promptCount = 0;
    this.reasons = [];
  }

  canAuthenticate() {
    return this.available;
  }

  async authenticate(reason) {
    this.promptCount += 1;
    this.reasons.push(reason);
    if (this.whilePromptIsShowing) await this.whilePromptIsShowing();
    return this.outcomes.length === 0 ? 'failed' : this.outcomes.shift();
  }
}

/** A clock the test can move. `read` is what the code under test calls. */
export class TestClock {
  constructor(start = Fx.now) {
    this.now = start;
    this.read = () => this.now;
  }

  /** Moves the clock by this many seconds (negative moves it back). */
  advance(seconds) {
    this.now += seconds * 1000;
  }
}

export const authenticator = (...outcomes) => new ScriptedAuthenticator(outcomes);
