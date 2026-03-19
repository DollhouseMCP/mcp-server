import { describe, it, expect, beforeEach } from '@jest/globals';
import { ElementEventDispatcher, type ElementLifecycleEvent } from '../../../src/events/ElementEventDispatcher.js';
import { ElementType } from '../../../src/portfolio/types.js';

function createPayload() {
  return {
    correlationId: 'test-correlation',
    elementType: ElementType.PERSONA as ElementType,
    elementId: 'element-123',
    filePath: 'personas/test.md',
    metadata: { name: 'Test Persona' }
  };
}

describe('ElementEventDispatcher', () => {
  let dispatcher: ElementEventDispatcher;

  beforeEach(() => {
    dispatcher = new ElementEventDispatcher();
  });

  it('emits synchronous events in registration order', () => {
    const events: ElementLifecycleEvent[] = [];
    dispatcher.on('element:load:start', () => events.push('element:load:start'));
    dispatcher.on('element:load:start', () => events.push('element:load:start#2'));

    dispatcher.emit('element:load:start', createPayload());

    expect(events).toEqual(['element:load:start', 'element:load:start#2']);
  });

  it('emits async events on next tick', async () => {
    const events: ElementLifecycleEvent[] = [];
    dispatcher.on('element:save:success', () => events.push('element:save:success'));

    dispatcher.emitAsync('element:save:success', createPayload());
    expect(events).toEqual([]); // not yet executed

    await new Promise(resolve => setImmediate(resolve));
    expect(events).toEqual(['element:save:success']);
  });

  it('supports unsubscribe semantics', () => {
    const events: ElementLifecycleEvent[] = [];
    const unsubscribe = dispatcher.on('element:cache:refresh', () => events.push('element:cache:refresh'));

    dispatcher.emit('element:cache:refresh', createPayload());
    unsubscribe();
    dispatcher.emit('element:cache:refresh', createPayload());

    expect(events).toEqual(['element:cache:refresh']);
  });
});
