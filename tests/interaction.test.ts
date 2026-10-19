import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { registerMathActivation } from '../src/interaction';

function fixture() {
  const dom = new JSDOM('<!doctype html><body><span></span></body>');
  const element = dom.window.document.querySelector('span')!;
  let composing = false, reveals = 0;
  const dispose = registerMathActivation(element, () => composing, () => { reveals++; });
  const send = (type: string, time: number, data: Record<string, unknown> = {}) => {
    const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
    const values = {timeStamp: time, pointerType: 'touch', isPrimary: true, pointerId: 1, clientX: 10, clientY: 10, button: 0, ...data};
    for (const [key, value] of Object.entries(values)) Object.defineProperty(event, key, {value});
    element.dispatchEvent(event);
    return event;
  };
  return {dom, element, send, dispose, settle: () => new Promise(resolve => dom.window.setTimeout(resolve, 10)), count: () => reveals, compose: (value: boolean) => { composing = value; }};
}

test('touch tap waits for click and pending browser events, then reveals exactly once', async () => {
  const f = fixture();
  assert.equal(f.send('pointerdown', 100).defaultPrevented, false);
  f.send('pointerup', 180);
  f.send('mousedown', 190);
  assert.equal(f.count(), 0, 'do not detach the touch target during pointerup/mousedown');
  f.send('click', 195);
  assert.equal(f.count(), 0, 'pending native selection/input is processed first');
  await f.settle();
  assert.equal(f.count(), 1);
  f.send('pointerdown', 200, {pointerType: 'mouse'});
  f.send('mousedown', 201);
  f.send('click', 202);
  await f.settle();
  assert.equal(f.count(), 2, 'a real mouse still works immediately after touch');
  f.dom.window.close();
});

test('scrolls, long presses, cancelled and multi-touch gestures do not reveal math', async () => {
  for (const gesture of ['scroll', 'hold', 'cancel', 'multi']) {
    const f = fixture();
    f.send('pointerdown', 100);
    if (gesture === 'scroll') { f.send('pointermove', 200, {clientX: 60}); f.send('pointermove', 250); }
    if (gesture === 'cancel') f.send('pointercancel', 200);
    if (gesture === 'multi') f.send('pointerdown', 200, {isPrimary: false, pointerId: 2});
    f.send('pointerup', gesture === 'hold' ? 800 : 300);
    f.send('mousedown', 810);
    f.send('click', 820);
    await f.settle();
    assert.equal(f.count(), 0, gesture);
    f.dom.window.close();
  }
});

test('IME composition owns the caret and primary mouse clicks work after it ends', async () => {
  const f = fixture();
  f.compose(true);
  f.send('pointerdown', 100);
  f.send('pointerup', 150);
  f.send('mousedown', 2000);
  f.send('click', 2001);
  await f.settle();
  assert.equal(f.count(), 0);
  f.compose(false);
  f.send('mousedown', 2100, {button: 2});
  f.send('click', 2101, {button: 2});
  await f.settle();
  assert.equal(f.count(), 0);
  assert.equal(f.send('mousedown', 2200).defaultPrevented, true);
  f.send('click', 2201);
  await f.settle();
  assert.equal(f.count(), 1);
  f.dom.window.close();
});

test('a queued activation cannot outlive its widget or start during composition', async () => {
  for (const reason of ['detached', 'disposed', 'composing']) {
    const f = fixture();
    f.send('click', 100);
    if (reason === 'detached') f.element.remove();
    if (reason === 'disposed') f.dispose();
    if (reason === 'composing') f.compose(true);
    await f.settle();
    assert.equal(f.count(), 0, reason);
    f.dom.window.close();
  }
});

test('modified clicks, double clicks and interactive children keep their own action', async () => {
  const f = fixture();
  try {
    for (const data of [{shiftKey: true}, {ctrlKey: true}, {metaKey: true}, {altKey: true}, {detail: 2}]) {
      f.send('click', 100, data);
      await f.settle();
      assert.equal(f.count(), 0);
    }
    const link = f.element.appendChild(f.dom.window.document.createElement('a'));
    const event = new f.dom.window.MouseEvent('click', {bubbles: true, cancelable: true, button: 0});
    link.dispatchEvent(event);
    await f.settle();
    assert.equal(event.defaultPrevented, false);
    assert.equal(f.count(), 0);
  } finally { f.dom.window.close(); }
});
