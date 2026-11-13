import { describe, expect, it } from 'vitest';
import type { UciChange } from '../api/types';
import { describeChanges } from './ApplyDialog';

describe('describeChanges', () => {
  it('folds options of a new section into its add line', () => {
    const changes: UciChange[] = [
      ['add', 'cfg06fe63', 'host'],
      ['list-add', 'cfg06fe63', 'mac', 'DA:A1:19:00:01:11'],
      ['set', 'cfg06fe63', 'name', 'phone'],
      ['set', 'cfg06fe63', 'ip', '10.231.1.192'],
      ['set', 'lan', 'leasetime', '1h'],
    ];
    expect(describeChanges(changes)).toEqual([
      {
        kind: 'add',
        section: 'cfg06fe63',
        value: 'host',
        fields: [
          { option: 'mac', value: 'DA:A1:19:00:01:11' },
          { option: 'name', value: 'phone' },
          { option: 'ip', value: '10.231.1.192' },
        ],
      },
      { kind: 'set', section: 'lan', option: 'leasetime', value: '1h' },
    ]);
  });

  it('merges list entries and drops the remove that precedes a list set', () => {
    const changes: UciChange[] = [
      ['remove', 'lan', 'dns'],
      ['list-add', 'lan', 'dns', '1.1.1.1'],
      ['list-add', 'lan', 'dns', '9.9.9.9'],
      ['set', 'newnet', 'interface'],
      ['list-add', 'newnet', 'ports', 'lan1'],
      ['list-add', 'newnet', 'ports', 'lan2'],
    ];
    expect(describeChanges(changes)).toEqual([
      { kind: 'set', section: 'lan', option: 'dns', value: '1.1.1.1, 9.9.9.9' },
      { kind: 'add', section: 'newnet', value: 'interface', fields: [{ option: 'ports', value: 'lan1, lan2' }] },
    ]);
  });

  it('keeps the last value of a re-set option and drops sections created then deleted', () => {
    const changes: UciChange[] = [
      ['add', 'cfg1', 'redirect'],
      ['set', 'cfg1', 'name', 'a'],
      ['set', 'cfg1', 'name', 'b'],
      ['remove', 'cfg1', 'name'],
      ['add', 'cfg2', 'rule'],
      ['remove', 'cfg2'],
      ['remove', 'cfg0f92bd'],
    ];
    expect(describeChanges(changes)).toEqual([
      { kind: 'add', section: 'cfg1', value: 'redirect', fields: [] },
      { kind: 'remove', section: 'cfg0f92bd', option: undefined },
    ]);
  });
});
