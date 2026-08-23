import { describe, expect, it } from 'vitest';
import {
  interruptedNavigationTarget,
  isRetriableOplataLoadError,
} from './helpers/yookassa-navigation';

describe('r13-M4 повтор gotoOplata только после abort, не Timeout', () => {
  it('Timeout не является причиной повторного goto', () => {
    expect(isRetriableOplataLoadError('Timeout 5000ms exceeded')).toBe(false);
    expect(isRetriableOplataLoadError('page.goto: Timeout')).toBe(false);
  });

  it('abort навигации на ЮKassa — допустимый повтор', () => {
    expect(isRetriableOplataLoadError('net::ERR_ABORTED')).toBe(true);
    expect(isRetriableOplataLoadError('Navigation interrupted')).toBe(true);
  });

  it('interrupted на тот же /oplata разбирается как цель для waitForURL, не второй goto', () => {
    const message =
      'page.goto: Navigation to "http://127.0.0.1:4322/oplata" is interrupted by another navigation to "http://127.0.0.1:4322/oplata"';
    expect(interruptedNavigationTarget(message)).toBe('http://127.0.0.1:4322/oplata');
    expect(isRetriableOplataLoadError(message)).toBe(true);
  });
});
