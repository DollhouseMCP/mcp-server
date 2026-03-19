import { describe, it, expect, jest } from '@jest/globals';
import {
  StateChangeNotifier,
  type PersonaStateChangeEvent,
} from '../../../src/services/StateChangeNotifier.js';

describe('StateChangeNotifier', () => {
  it('emits generic and typed events', () => {
    const notifier = new StateChangeNotifier();
    const handler = jest.fn();
    const typed = jest.fn();

    notifier.on('state-change', handler);
    notifier.on('state-change:persona-activated', typed);

    const event: PersonaStateChangeEvent = {
      type: 'persona-activated',
      previousValue: null,
      newValue: 'persona-1',
      timestamp: new Date(),
    };

    notifier.notifyPersonaChange(event);

    expect(handler).toHaveBeenCalledWith(event);
    expect(typed).toHaveBeenCalledWith(event);
  });

  it('removes listeners on dispose', async () => {
    const notifier = new StateChangeNotifier();
    const handler = jest.fn();

    notifier.on('state-change', handler);
    await notifier.dispose();

    expect(notifier.listenerCount('state-change')).toBe(0);
  });
});
