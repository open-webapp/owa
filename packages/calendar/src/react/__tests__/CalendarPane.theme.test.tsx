import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { CalendarPane, type CalendarPaneProps } from '../../index.js';
import { createFakeController, makeEvent, SOURCE, type RsvpSelection } from './helpers.js';

const sources = [SOURCE, { id: 's2', email: 'other@example.com' }];
const calendars = [
  { id: 'primary', summary: 'Work primary', primary: true },
  { id: 'team', summary: 'Work team', primary: false },
];
type Theme = CalendarPaneProps['theme'];

describe('CalendarPane theme prop', () => {
  it.each(['uncached error', 'cached error', 'loading', 'empty'] as const)(
    'keeps %s content and callbacks stable with live modes and a legacy controller', (state) => {
      const cached = state === 'cached error';
      const error = state.includes('error');
      const controller = createFakeController({
        sources: [SOURCE], status: { s1: error ? 'error' : 'ok' },
        events: cached ? [makeEvent({ summary: 'Cached appointment' })] : [],
        state: { loading: state === 'loading', error },
      });
      // Older hosts omit these optional controller capabilities.
      const { getState: _getState, hydrate: _hydrate, ...legacyController } = controller;
      const props = {
        sources: [SOURCE], controller: state === 'loading' ? controller : legacyController,
        selectedRsvpStatuses: new Set(['accepted'] as const), onRsvpStatusesChange: vi.fn(),
        onConnect: vi.fn(), onReconnect: vi.fn(),
      };
      const { container, rerender } = render(<CalendarPane {...props} />);
      const root = container.firstChild;
      for (const theme of [undefined, 'dark', 'light', 'system', undefined] as const) {
        rerender(<CalendarPane {...props} theme={theme} />);
        expect(container.firstChild).toBe(root);
        expect(root).toHaveAttribute('data-calendar-theme', theme ?? 'system');
        if (cached) {
          expect(screen.getByRole('link', { name: 'Cached appointment' })).toBeVisible();
          expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        } else if (error) {
          expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load calendar events. Try again shortly.");
        } else {
          expect(screen.getByText(state === 'loading' ? 'Loading calendar…' : 'No matching events in the next 30 days',
            { exact: true })).toBeVisible();
        }
        expect(props.onRsvpStatusesChange).not.toHaveBeenCalled();
        expect(props.onConnect).not.toHaveBeenCalled();
        expect(props.onReconnect).not.toHaveBeenCalled();
        expect(controller.refresh).not.toHaveBeenCalled();
      }
      fireEvent.click(screen.getByRole('button', { name: 'Maybe' }));
      expect(props.onRsvpStatusesChange).toHaveBeenCalledTimes(1);
      expect(props.onRsvpStatusesChange).toHaveBeenLastCalledWith(new Set(['accepted', 'tentative']));
    },
  );

  it.each([
    ['disconnected', 'Not connected to Google Calendar.', 'Connect Google Calendar'],
    ['reauth', 'Calendar connection needs reauthorization.', 'Reconnect to restore sync'],
  ] as const)('preserves the %s prompt and exact callback contract through theme changes', (state, copy, button) => {
    const controller = createFakeController({ sources: [SOURCE], status: { s1: 'needs-scope' } });
    const onConnect = vi.fn();
    const onReconnect = vi.fn();
    const props = {
      sources: [SOURCE], controller, connected: state !== 'disconnected',
      selectedRsvpStatuses: new Set(['accepted'] as const), onRsvpStatusesChange: vi.fn(),
      onConnect, onReconnect,
    };
    const { container, rerender } = render(<CalendarPane {...props} />);
    const root = container.firstChild;
    const promptButton = screen.getByRole('button', { name: button });
    for (const theme of [undefined, 'dark', 'light', 'system', undefined] as const) {
      rerender(<CalendarPane {...props} theme={theme} />);
      expect(container.firstChild).toBe(root);
      expect(root).toHaveAttribute('data-calendar-theme', theme ?? 'system');
      expect(screen.getByText(copy, { exact: true })).toBeVisible();
      expect(screen.getByRole('button', { name: button })).toBe(promptButton);
      expect(onConnect).not.toHaveBeenCalled();
      expect(onReconnect).not.toHaveBeenCalled();
    }
    fireEvent.click(promptButton);
    expect(state === 'disconnected' ? onConnect : onReconnect).toHaveBeenCalledTimes(1);
    expect(state === 'disconnected' ? onReconnect : onConnect).not.toHaveBeenCalled();
    expect(props.onRsvpStatusesChange).not.toHaveBeenCalled();
    expect(controller.refresh).not.toHaveBeenCalled();
  });

  it('forwards live modes to both sources without losing dropdown or saved RSVP selection', () => {
    const controller = createFakeController({
      sources,
      calendars: { s1: calendars, s2: calendars },
      selected: { s1: ['primary'], s2: ['primary'] },
      events: [makeEvent({ summary: 'Pending invitation', selfResponseStatus: 'needsAction' })],
    });
    const onRsvpStatusesChange = vi.fn();
    const original: RsvpSelection = new Set(['accepted', 'tentative']);
    function Host({ theme }: { theme?: Theme }) {
      const [selection, setSelection] = useState(original);
      return <CalendarPane sources={sources} controller={controller} theme={theme}
        selectedRsvpStatuses={selection} onRsvpStatusesChange={(next) => {
          onRsvpStatusesChange(next);
          setSelection(next);
        }} />;
    }
    const { container, rerender } = render(<Host theme="dark" />);
    fireEvent.click(screen.getByRole('button', { name: 'Unaccepted (1)' }));
    expect(onRsvpStatusesChange).toHaveBeenNthCalledWith(1, new Set(['needsAction']));
    const triggers = screen.getAllByRole('combobox');
    expect(triggers).toHaveLength(1);
    fireEvent.click(triggers[0]);
    expect(screen.getByRole('heading', { name: SOURCE.email })).toBeVisible();
    const search = screen.getByRole('searchbox');
    fireEvent.change(search, { target: { value: 'Work' } });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    const firstGroup = screen.getByRole('group', { name: SOURCE.email });
    const activeId = within(firstGroup).getByRole('option', { name: 'Work team' }).id;
    for (const theme of ['light', 'system', undefined, 'dark'] as const) {
      rerender(<Host theme={theme} />);
      expect(container.firstChild).toHaveAttribute('data-calendar-theme', theme ?? 'system');
      expect(container.querySelectorAll('.calendar-selector')).toHaveLength(1);
      for (const root of container.querySelectorAll('.calendar-selector')) {
        expect(root).toHaveAttribute('data-calendar-theme', theme ?? 'system');
      }
      expect(screen.getAllByRole('combobox')).toEqual(triggers);
      expect(triggers[0]).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByRole('searchbox')).toBe(search);
      expect(search).toHaveValue('Work');
      expect(search).toHaveFocus();
      expect(screen.getByRole('listbox')).toHaveAttribute('aria-activedescendant', activeId);
      for (const option of screen.getAllByRole('option', { name: 'Work primary' })) expect(option).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByRole('button', { name: 'Unaccepted (1)' })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByRole('link', { name: 'Pending invitation' })).toBeVisible();
      expect(onRsvpStatusesChange).toHaveBeenCalledTimes(1);
      expect(controller.setSelectedIds).not.toHaveBeenCalled();
      expect(controller.refresh).not.toHaveBeenCalled();
      expect(controller.hydrate).toHaveBeenCalledTimes(1);
    }
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(controller.setSelectedIds).toHaveBeenCalledTimes(1);
    expect(controller.setSelectedIds).toHaveBeenLastCalledWith('s1', ['primary', 'team']);
    rerender(<Host theme="light" />);
    expect(within(firstGroup).getByRole('option', { name: 'Work team' })).toHaveAttribute('aria-selected', 'true');
    // Shared search and keyboard traversal cross the account boundary.
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(screen.getByRole('heading', { name: sources[1].email })).toBeVisible();
    const secondOption = within(screen.getByRole('group', { name: sources[1].email })).getByRole('option', { name: 'Work team' });
    expect(screen.getByRole('listbox')).toHaveAttribute('aria-activedescendant', secondOption.id);
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(controller.setSelectedIds).toHaveBeenNthCalledWith(2, 's2', ['primary', 'team']);
    fireEvent.click(screen.getByRole('button', { name: 'Unaccepted (1)' }));
    expect(onRsvpStatusesChange).toHaveBeenCalledTimes(2);
    expect(onRsvpStatusesChange).toHaveBeenLastCalledWith(original);
    expect(screen.getByRole('button', { name: 'Accepted' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Maybe' })).toHaveAttribute('aria-pressed', 'true');
  });
});
