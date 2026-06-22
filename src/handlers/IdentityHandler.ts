/**
 * IdentityHandler - Manages user identity and attribution
 *
 * Handles user identity management for persona attribution including:
 * - Setting user identity (username and optional email)
 * - Retrieving current identity status
 * - Clearing identity to return to anonymous mode
 * - Providing attribution for new personas
 *
 * Identity state now flows through PersonaManager for DI integration.
 */

import { validateUsername, sanitizeInput } from '../security/InputValidator.js';
import { VALIDATION_PATTERNS } from '../security/constants.js';
import { SecureErrorHandler } from '../security/errorHandler.js';
import { PersonaManager } from '../persona/PersonaManager.js';
import { InitializationService } from '../services/InitializationService.js';
import { PersonaIndicatorService } from '../services/PersonaIndicatorService.js';
import { SecurityMonitor } from '../security/securityMonitor.js';
import type { ContextTracker } from '../security/encryption/ContextTracker.js';
import type { UserIdentityService } from '../services/UserIdentityService.js';
import type { SessionActivationRegistry } from '../state/SessionActivationState.js';

export class IdentityHandler {
  private userIdentityService?: UserIdentityService;
  private sessionActivationRegistry?: SessionActivationRegistry;

  constructor(
    private readonly personaManager: PersonaManager,
    private readonly initService: InitializationService,
    private readonly indicatorService: PersonaIndicatorService,
    private readonly contextTracker?: ContextTracker
  ) {}

  /**
   * Enable database identity binding. When set, set_user_identity will
   * create/resolve a DB user row and store the UUID in the session state.
   */
  setDatabaseIdentityServices(
    service: UserIdentityService,
    registry: SessionActivationRegistry,
  ): void {
    this.userIdentityService = service;
    this.sessionActivationRegistry = registry;
  }

  private async ensureInitialized(): Promise<void> {
    await this.initService.ensureInitialized();
  }

  private withIndicator(message: string): string {
    const indicator = this.indicatorService.getPersonaIndicator();
    return `${indicator}${message}`;
  }

  /**
   * Set user identity for attribution
   * @param username - Username to set (alphanumeric, hyphens, underscores, dots)
   * @param email - Optional email address
   */
  async setUserIdentity(username: string, email?: string) {
    await this.ensureInitialized();

    try {
      if (!username || username.trim().length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: this.withIndicator('❌ Username cannot be empty'),
            },
          ],
        };
      }

      const validatedUsername = validateUsername(username);

      let validatedEmail: string | undefined;
      if (email) {
        const sanitizedEmail = sanitizeInput(email, 100);
        if (!VALIDATION_PATTERNS.SAFE_EMAIL.test(sanitizedEmail)) {
          throw new Error('Invalid email format');
        }
        validatedEmail = sanitizedEmail;
      }

      this.personaManager.setUserIdentity(validatedUsername, validatedEmail);

      // In DB mode, resolve or create a database user row and bind the
      // session's RLS context to that user's UUID.
      if (this.userIdentityService && this.sessionActivationRegistry && this.contextTracker) {
        const session = this.contextTracker.getSessionContext();
        if (session) {
          const dbUserId = await this.userIdentityService.resolveOrCreateUser(
            validatedUsername,
            validatedEmail,
          );
          const activationState = this.sessionActivationRegistry.getOrCreate(session.sessionId);
          activationState.dbUserId = dbUserId;
        }
      }

      const { username: currentUsername, email: currentEmail } = this.personaManager.getUserIdentity();

      SecurityMonitor.logSecurityEvent({
        type: 'IDENTITY_CHANGED',
        severity: 'LOW',
        source: 'IdentityHandler.setUserIdentity',
        details: `User identity set: ${currentUsername}`,
        additionalData: {
          username: currentUsername,
          emailProvided: !!currentEmail
        }
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: this.withIndicator(
              `✅ **User Identity Set**\n\n` +
                `👤 **Username:** ${currentUsername}\n` +
                `${currentEmail ? `📧 **Email:** ${currentEmail}\n` : ''}` +
                `\n🎯 **Next Steps:**\n` +
                `• New personas you create will be attributed to "${currentUsername}"\n` +
                `• Set environment variable \`DOLLHOUSE_USER=${currentUsername}\` to persist this setting\n` +
                `${currentEmail ? `• Set environment variable \`DOLLHOUSE_EMAIL=${currentEmail}\` for contact info\n` : ''}` +
                `• Use \`clear_user_identity\` to return to anonymous mode`
            ),
          },
        ],
      };
    } catch (error) {
      const sanitized = SecureErrorHandler.sanitizeError(error);
      return {
        content: [
          {
            type: 'text' as const,
            text:
              this.withIndicator('❌ **Validation Error**\n\n') +
              `${sanitized.message}\n\n` +
              `Please provide a valid username (alphanumeric characters, hyphens, underscores, dots only).`,
          },
        ],
      };
    }
  }

  /**
   * Get current user identity status
   * Shows username, email (if set), and attribution status
   */
  async getUserIdentity() {
    await this.ensureInitialized();

    const { username: currentUsername, email } = this.personaManager.getUserIdentity();

    if (!currentUsername) {
      return {
        content: [
          {
            type: 'text' as const,
            text: this.withIndicator(
              `👤 **User Identity: Anonymous**\n\n` +
                `🔒 **Status:** Anonymous mode\n` +
                `📝 **Attribution:** Personas will use anonymous IDs\n\n` +
                `**To set your identity:**\n` +
                `• Use: \`set_user_identity "your-username"\`\n` +
                `• Or set environment variable: \`DOLLHOUSE_USER=your-username\``
            ),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: this.withIndicator(
            `👤 **User Identity: ${currentUsername}**\n\n` +
              `✅ **Status:** Authenticated\n` +
              `👤 **Username:** ${currentUsername}\n` +
              `${email ? `📧 **Email:** ${email}\n` : ''}` +
              `📝 **Attribution:** New personas will be credited to "${currentUsername}"\n\n` +
              `**Environment Variables:**\n` +
              `• \`DOLLHOUSE_USER=${currentUsername}\`\n` +
              `${email ? `• \`DOLLHOUSE_EMAIL=${email}\`\n` : ''}` +
              `\n**Management:**\n` +
              `• Use \`clear_user_identity\` to return to anonymous mode\n` +
              `• Use \`set_user_identity "new-username"\` to change username`
          ),
        },
      ],
    };
  }

  /**
   * Clear user identity and return to anonymous mode
   */
  async clearUserIdentity() {
    await this.ensureInitialized();

    const { username: currentUsername } = this.personaManager.getUserIdentity();
    const wasSet = currentUsername !== null;
    const previousUser = currentUsername;

    this.personaManager.clearUserIdentity();

    // Clear the DB identity override so the session falls back to default
    if (this.sessionActivationRegistry && this.contextTracker) {
      const session = this.contextTracker.getSessionContext();
      if (session) {
        const activationState = this.sessionActivationRegistry.get(session.sessionId);
        if (activationState) {
          activationState.dbUserId = undefined;
        }
      }
    }

    // FIX: DMCP-SEC-006 - Add security audit logging for identity clearing
    if (wasSet) {
      SecurityMonitor.logSecurityEvent({
        type: 'ELEMENT_DELETED',
        severity: 'LOW',
        source: 'IdentityHandler.clearUserIdentity',
        details: `User identity cleared: previous=${previousUser}`,
        additionalData: {
          previousUsername: previousUser
        }
      });
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: wasSet
            ? this.withIndicator(
                `✅ **User Identity Cleared**\n\n` +
                  `👤 **Previous:** ${previousUser}\n` +
                  `🔒 **Current:** Anonymous mode\n\n` +
                  `📝 **Effect:** New personas will use anonymous IDs\n\n` +
                  `⚠️ **Note:** This only affects the current session.\n` +
                  `To persist this change, unset the \`DOLLHOUSE_USER\` environment variable.`
              )
            : this.withIndicator(
                `ℹ️ **Already in Anonymous Mode**\n\n` +
                  `👤 No user identity was set.\n\n` +
                  `Use \`set_user_identity "username"\` to set your identity.`
              ),
        },
      ],
    };
  }

  /**
   * Get current user for attribution purposes
   * Returns username if set, otherwise PersonaManager's anonymous ID
   */
  public getCurrentUserForAttribution(): string {
    return this.personaManager.getCurrentUserForAttribution();
  }
}
