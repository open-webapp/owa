export type Entry = {
  id: string;
  date: string;  // ISO YYYY-MM-DD
  time: string;  // HH:MM
  text: string;
  archived?: boolean;
  doneAt?: number;  // epoch ms; absent when not done
  createdAt: number;  // epoch ms
  updatedAt?: number;  // epoch ms, bumped on text edits (not archive/restore); absent on entries persisted before this field existed (treated as 0 by merge)
};

export type FilterRule = {
  id: string;
  filter: string;
  fileName: string;
  isRemainder: boolean;
};

export type Tombstone = {
  id: string;
  removedAt: number;
};
