// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Bars } from './Bars';
import { Bullet, attainment, attainmentState } from './Bullet';
import { Donut, foldSmall } from './Donut';
import { LineArea } from './LineArea';
import { RankedBars } from './RankedBars';
import { Sparkline } from './Sparkline';
import { nextIndex } from './shared';

afterEach(cleanup);

const KES = { kind: 'money', currency: 'KES' } as const;
const cats = ['1 Mar', '2 Mar', '3 Mar', '4 Mar'];

describe('LineArea', () => {
  const series = [
    { key: 'a', label: 'This period', values: [100, 250, null, 400] },
    { key: 'b', label: 'Last year', values: [80, 200, 300, 350], dashed: true },
  ];

  it('is a labelled, focusable group that says how to read it', () => {
    render(<LineArea categories={cats} series={series} unit={KES} ariaLabel="Daily sales" />);
    const group = screen.getByRole('group', { name: /Daily sales\. 4 points/ });
    expect(group).toHaveAttribute('tabindex', '0');
  });

  it('reads out a day with the arrow keys, listing every series, with a gap as a dash', () => {
    render(<LineArea categories={cats} series={series} unit={KES} ariaLabel="Daily sales" />);
    const group = screen.getByRole('group', { name: /Daily sales/ });
    fireEvent.focus(group);
    // Focus starts on the last point.
    expect(screen.getByRole('status')).toHaveTextContent('4 Mar');
    fireEvent.keyDown(group, { key: 'ArrowLeft' });
    fireEvent.keyDown(group, { key: 'ArrowLeft' });
    const tip = screen.getByRole('status');
    expect(tip).toHaveTextContent('2 Mar');
    expect(within(tip).getByText('KES 250')).toBeInTheDocument();
    expect(within(tip).getByText('KES 200')).toBeInTheDocument();
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(screen.getByRole('status')).toHaveTextContent('3 Mar');
    expect(within(screen.getByRole('status')).getByText('–')).toBeInTheDocument();
    fireEvent.keyDown(group, { key: 'Home' });
    expect(screen.getByRole('status')).toHaveTextContent('1 Mar');
    fireEvent.keyDown(group, { key: 'End' });
    expect(screen.getByRole('status')).toHaveTextContent('4 Mar');
  });

  it('offers the same numbers as a real table', () => {
    render(<LineArea categories={cats} series={series} unit={KES} ariaLabel="Daily sales" />);
    const table = screen.getByRole('table', { name: 'Daily sales' });
    expect(within(table).getByRole('columnheader', { name: 'This period' })).toBeInTheDocument();
    expect(within(table).getByRole('rowheader', { name: '3 Mar' })).toBeInTheDocument();
    expect(within(table).getByText('KES 400')).toBeInTheDocument();
  });

  it('draws a dashed reference line and a legend entry for each series', () => {
    const { container } = render(
      <LineArea categories={cats} series={series} unit={KES} ariaLabel="Daily sales" />,
    );
    expect(container.querySelectorAll('path[stroke-dasharray]')).toHaveLength(1);
    expect(screen.getAllByText('Last year').length).toBeGreaterThan(0);
  });

  it('draws nothing for no categories', () => {
    const { container } = render(
      <LineArea categories={[]} series={[]} unit={KES} ariaLabel="Daily sales" />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('Bars', () => {
  it('reads out a group with the arrow keys and offers a table', () => {
    render(
      <Bars
        categories={['Nairobi', 'Mombasa']}
        series={[{ key: 'm', label: 'Sales', values: [900, 400] }]}
        unit={KES}
        ariaLabel="Sales by branch"
      />,
    );
    const group = screen.getByRole('group', { name: /Sales by branch/ });
    fireEvent.focus(group);
    expect(screen.getByRole('status')).toHaveTextContent('Nairobi');
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(screen.getByRole('status')).toHaveTextContent('Mombasa');
    expect(screen.getByRole('table', { name: 'Sales by branch' })).toBeInTheDocument();
  });

  it('draws one bar per value, stacked or grouped, and none for zero or missing', () => {
    const series = [
      { key: 'a', label: 'A', values: [10, 0, null] },
      { key: 'b', label: 'B', values: [5, 7, 9] },
    ];
    const grouped = render(
      <Bars categories={['x', 'y', 'z']} series={series} unit={KES} ariaLabel="G" />,
    );
    expect(grouped.container.querySelectorAll('svg rect')).toHaveLength(4);
    cleanup();
    const stacked = render(
      <Bars stacked categories={['x', 'y', 'z']} series={series} unit={KES} ariaLabel="S" />,
    );
    expect(stacked.container.querySelectorAll('svg rect')).toHaveLength(4);
  });

  it('lets bars below zero hang under the axis without breaking', () => {
    const { container } = render(
      <Bars
        categories={['a', 'b']}
        series={[{ key: 'v', label: 'Variance', values: [-50, 100] }]}
        unit={KES}
        ariaLabel="Variance"
      />,
    );
    for (const rect of container.querySelectorAll('svg rect')) {
      expect(Number(rect.getAttribute('height'))).toBeGreaterThan(0);
      expect(rect.getAttribute('y')).not.toBe('NaN');
    }
  });
});

describe('RankedBars', () => {
  const items = [
    { key: 'a', label: 'Sunlight soap', value: 1000, note: '40 units', changePct: 12.5 },
    { key: 'b', label: 'Milk', value: 500, changePct: -3 },
    { key: 'c', label: 'Flour', value: 250, changePct: null },
  ];

  it('is an ordered list, best first, with figures and initials', () => {
    render(<RankedBars items={items} unit={KES} ariaLabel="Best sellers" />);
    const list = screen.getByRole('list', { name: 'Best sellers' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('Sunlight soap');
    expect(rows[0]).toHaveTextContent('KES 1,000');
    expect(rows[0]).toHaveTextContent('SS');
  });

  it('writes the change in words, not only colour, and nothing when there is nothing to compare', () => {
    render(<RankedBars items={items} unit={KES} ariaLabel="Best sellers" />);
    expect(screen.getByText(/Up 12.5%/)).toBeInTheDocument();
    expect(screen.getByText(/Down 3%/)).toBeInTheDocument();
  });

  it('scales bars to the largest and respects the limit', () => {
    const { container } = render(
      <RankedBars items={items} unit={KES} ariaLabel="Best sellers" limit={2} />,
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    const bars = container.querySelectorAll<HTMLElement>('li span[style*="width"]');
    expect(bars[0]?.style.width).toBe('100%');
    expect(bars[1]?.style.width).toBe('50%');
  });

  it('turns an item with a link into a link', () => {
    render(
      <RankedBars
        items={[{ key: 'a', label: 'Soap', value: 10, href: '/admin/p/1' }]}
        unit={KES}
        ariaLabel="x"
      />,
    );
    expect(screen.getByRole('link')).toHaveAttribute('href', '/admin/p/1');
  });
});

describe('Donut', () => {
  it('folds everything beyond six parts into Other and drops zero and bad values', () => {
    const items = Array.from({ length: 9 }, (_, i) => ({
      key: `k${String(i)}`,
      label: `Part ${String(i)}`,
      value: 100 - i,
    }));
    const folded = foldSmall([
      ...items,
      { key: 'z', label: 'Zero', value: 0 },
      { key: 'n', label: 'Neg', value: -5 },
    ]);
    expect(folded).toHaveLength(6);
    expect(folded.at(-1)?.label).toBe('Other');
    expect(folded.reduce((a, p) => a + p.value, 0)).toBe(items.reduce((a, p) => a + p.value, 0));
  });

  it('describes itself and lists every part with its share', () => {
    render(
      <Donut
        items={[
          { key: 'm', label: 'M-Pesa', value: 750 },
          { key: 'c', label: 'Cash', value: 250 },
        ]}
        unit={KES}
        centerLabel="collected"
        ariaLabel="Collected"
      />,
    );
    expect(
      screen.getByRole('img', { name: /Collected: M-Pesa KES 750, Cash KES 250/ }),
    ).toBeInTheDocument();
    expect(screen.getByText('75%')).toBeInTheDocument();
    expect(screen.getByText('25%')).toBeInTheDocument();
  });

  it('copes with nothing to show', () => {
    render(<Donut items={[]} unit={KES} centerLabel="collected" ariaLabel="Collected" />);
    expect(screen.getByTestId('donut')).toBeInTheDocument();
  });
});

describe('Bullet', () => {
  it('works out attainment and its state', () => {
    expect(attainment(50, 100)).toBe(50);
    expect(attainment(150, 100)).toBe(150);
    expect(attainment(10, 0)).toBeNull();
    expect(attainment(Number.NaN, 100)).toBeNull();
    expect(attainmentState(null)).toBe('none');
    expect(attainmentState(40)).toBe('behind');
    expect(attainmentState(70)).toBe('close');
    expect(attainmentState(100)).toBe('met');
    expect(attainmentState(80, 90, 110)).toBe('behind');
  });

  it('states the position in words and as a meter', () => {
    render(<Bullet label="Westlands" actual={700} target={1000} unit={KES} />);
    const meter = screen.getByRole('meter', { name: 'Westlands' });
    expect(meter).toHaveAttribute('aria-valuenow', '70');
    expect(meter).toHaveAttribute('aria-valuetext', '70% of target. Close to target');
    expect(screen.getByText(/70% of target · Close to target/)).toBeInTheDocument();
  });

  it('shows a met target full, and says so when there is no target', () => {
    render(<Bullet label="A" actual={1200} target={1000} unit={KES} />);
    expect(screen.getByTestId('bullet')).toHaveAttribute('data-state', 'met');
    cleanup();
    render(<Bullet label="B" actual={5} target={null} unit={KES} />);
    expect(screen.getByTestId('bullet')).toHaveAttribute('data-state', 'none');
    expect(screen.getByText('No target set')).toBeInTheDocument();
  });
});

describe('Sparkline', () => {
  it('describes itself and draws a path', () => {
    const { container } = render(<Sparkline values={[1, 3, 2, 5]} label="Sales" />);
    expect(
      screen.getByRole('img', { name: 'Sales: from 1 to 5 over 4 points' }),
    ).toBeInTheDocument();
    expect(container.querySelector('path')?.getAttribute('d')).toMatch(/^M/);
  });

  it('draws nothing for one point or all zeros', () => {
    expect(render(<Sparkline values={[3]} label="x" />).container).toBeEmptyDOMElement();
    cleanup();
    expect(render(<Sparkline values={[0, 0, 0]} label="x" />).container).toBeEmptyDOMElement();
  });
});

describe('keyboard movement', () => {
  it('moves through points and ignores other keys', () => {
    expect(nextIndex('ArrowLeft', null, 5)).toBe(4);
    expect(nextIndex('ArrowLeft', 0, 5)).toBe(0);
    expect(nextIndex('ArrowRight', null, 5)).toBe(0);
    expect(nextIndex('ArrowRight', 4, 5)).toBe(4);
    expect(nextIndex('Home', 3, 5)).toBe(0);
    expect(nextIndex('End', 1, 5)).toBe(4);
    expect(nextIndex('a', 1, 5)).toBeNull();
    expect(nextIndex('ArrowLeft', null, 0)).toBeNull();
  });
});
