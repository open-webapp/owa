import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CalendarPane } from '../CalendarPane.js';
import { createFakeController, makeEvent, SOURCE } from './helpers.js';

describe('CalendarPane with 0.1.0-style controller', () => {
  it('renders events when controller lacks getState and hydrate', () => {
    const full = createFakeController({ sources: [SOURCE], events: [makeEvent({ id: 'l1', summary: 'Legacy event' })] });
    const { getState, hydrate, retryDeferred, ...legacy } = full as any;
    void getState; void hydrate; void retryDeferred;
    render(
      <CalendarPane
        {...({ sources: [SOURCE], controller: legacy, selectedRsvpStatuses: new Set(['accepted', 'tentative', 'needsAction']), onRsvpStatusesChange: vi.fn() } as any)}
      />,
    );
    expect(screen.getByText('Legacy event')).toBeInTheDocument();
  });
});
