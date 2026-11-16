import {
  getStateColor,
  getStateLabel,
  hasEta,
  isActiveState,
  isCompletedState,
  isTorrentCompleted,
} from '@/utils/torrent-state';

const mockColors = {
  stateUploadAndDownload: '#upload-and-download',
  stateUploadOnly: '#upload-only',
  stateSeeding: '#seeding',
  stateDownloading: '#downloading',
  stateMetadata: '#metadata',
  statePaused: '#paused',
  stateError: '#error',
  stateChecking: '#checking',
  stateQueued: '#queued',
  stateStalled: '#stalled',
  stateOther: '#other',
};

describe('getStateColor', () => {
  describe('speed-based overrides', () => {
    it('returns stateUploadAndDownload when both dlspeed > 0 and upspeed > 0', () => {
      expect(getStateColor('downloading', 0.5, 1000, 500, mockColors)).toBe('#upload-and-download');
    });

    it('returns stateUploadOnly when only upspeed > 0', () => {
      expect(getStateColor('downloading', 0.5, 0, 500, mockColors)).toBe('#upload-only');
    });
  });

  describe('progress-based overrides', () => {
    it('returns stateSeeding for stalledUP with progress >= 1', () => {
      expect(getStateColor('stalledUP', 1, 0, 0, mockColors)).toBe('#seeding');
    });

    it('returns stateStalled for stalledUP with progress < 1', () => {
      expect(getStateColor('stalledUP', 0.5, 0, 0, mockColors)).toBe('#stalled');
    });
  });

  describe('state-based colors', () => {
    it('downloading → stateDownloading', () => {
      expect(getStateColor('downloading', 0.5, 0, 0, mockColors)).toBe('#downloading');
    });

    it('forcedDL → stateDownloading', () => {
      expect(getStateColor('forcedDL', 0.5, 0, 0, mockColors)).toBe('#downloading');
    });

    it('metaDL → stateMetadata', () => {
      expect(getStateColor('metaDL', 0, 0, 0, mockColors)).toBe('#metadata');
    });

    it('forcedMetaDL → stateMetadata', () => {
      expect(getStateColor('forcedMetaDL', 0, 0, 0, mockColors)).toBe('#metadata');
    });

    it('uploading → stateUploadOnly', () => {
      expect(getStateColor('uploading', 1, 0, 0, mockColors)).toBe('#upload-only');
    });

    it('forcedUP → stateUploadOnly', () => {
      expect(getStateColor('forcedUP', 1, 0, 0, mockColors)).toBe('#upload-only');
    });

    it('pausedDL → statePaused', () => {
      expect(getStateColor('pausedDL', 0.5, 0, 0, mockColors)).toBe('#paused');
    });

    it('pausedUP (finished-then-stopped) → stateSeeding', () => {
      expect(getStateColor('pausedUP', 1, 0, 0, mockColors)).toBe('#seeding');
    });

    it('stoppedDL → statePaused', () => {
      expect(getStateColor('stoppedDL', 0.5, 0, 0, mockColors)).toBe('#paused');
    });

    it('stoppedUP (finished-then-stopped) → stateSeeding', () => {
      expect(getStateColor('stoppedUP', 1, 0, 0, mockColors)).toBe('#seeding');
    });

    it('stoppedDL at 100% progress (qBittorrent state-machine gap) → stateSeeding', () => {
      expect(getStateColor('stoppedDL', 1, 0, 0, mockColors)).toBe('#seeding');
    });

    it('pausedDL at 100% progress (qBittorrent state-machine gap) → stateSeeding', () => {
      expect(getStateColor('pausedDL', 1, 0, 0, mockColors)).toBe('#seeding');
    });

    it('error → stateError', () => {
      expect(getStateColor('error', 0, 0, 0, mockColors)).toBe('#error');
    });

    it('missingFiles → stateError', () => {
      expect(getStateColor('missingFiles', 0, 0, 0, mockColors)).toBe('#error');
    });

    it('stalledDL → stateError', () => {
      expect(getStateColor('stalledDL', 0.5, 0, 0, mockColors)).toBe('#error');
    });

    it('checkingDL → stateChecking', () => {
      expect(getStateColor('checkingDL', 0.5, 0, 0, mockColors)).toBe('#checking');
    });

    it('checkingUP → stateChecking', () => {
      expect(getStateColor('checkingUP', 1, 0, 0, mockColors)).toBe('#checking');
    });

    it('queuedDL → stateQueued', () => {
      expect(getStateColor('queuedDL', 0, 0, 0, mockColors)).toBe('#queued');
    });

    it('queuedUP → stateQueued', () => {
      expect(getStateColor('queuedUP', 0, 0, 0, mockColors)).toBe('#queued');
    });

    it('stalledUP (incomplete) → stateStalled', () => {
      expect(getStateColor('stalledUP', 0.8, 0, 0, mockColors)).toBe('#stalled');
    });

    it('allocating → stateOther', () => {
      expect(getStateColor('allocating', 0, 0, 0, mockColors)).toBe('#other');
    });

    it('moving → stateOther', () => {
      expect(getStateColor('moving', 0.5, 0, 0, mockColors)).toBe('#other');
    });

    it('unknown → stateOther', () => {
      expect(getStateColor('unknown', 0, 0, 0, mockColors)).toBe('#other');
    });

    it('unrecognized state → stateOther (default)', () => {
      expect(getStateColor('somethingNew', 0, 0, 0, mockColors)).toBe('#other');
    });
  });
});

describe('getStateLabel', () => {
  describe('speed-based overrides', () => {
    it('returns "DL + UL" when both dlspeed > 0 and upspeed > 0', () => {
      expect(getStateLabel('downloading', 0.5, 1000, 500)).toBe('DL + UL');
    });

    it('returns "Uploading" when only upspeed > 0', () => {
      expect(getStateLabel('downloading', 0.5, 0, 500)).toBe('Uploading');
    });
  });

  describe('progress-based overrides', () => {
    it('returns "Seeding" for stalledUP with progress >= 1', () => {
      expect(getStateLabel('stalledUP', 1, 0, 0)).toBe('Seeding');
    });

    it('returns "Stalled UP" for stalledUP with progress < 1', () => {
      expect(getStateLabel('stalledUP', 0.5, 0, 0)).toBe('Stalled UP');
    });
  });

  describe('state labels', () => {
    it('downloading → "Downloading"', () => {
      expect(getStateLabel('downloading', 0.5, 0, 0)).toBe('Downloading');
    });

    it('metaDL → "Metadata"', () => {
      expect(getStateLabel('metaDL', 0, 0, 0)).toBe('Metadata');
    });

    it('forcedMetaDL → "Forced Meta"', () => {
      expect(getStateLabel('forcedMetaDL', 0, 0, 0)).toBe('Forced Meta');
    });

    it('forcedDL → "Forced DL"', () => {
      expect(getStateLabel('forcedDL', 0.5, 0, 0)).toBe('Forced DL');
    });

    it('uploading → "Uploading"', () => {
      expect(getStateLabel('uploading', 1, 0, 0)).toBe('Uploading');
    });

    it('forcedUP → "Forced UP"', () => {
      expect(getStateLabel('forcedUP', 1, 0, 0)).toBe('Forced UP');
    });

    it('pausedDL → "Paused"', () => {
      expect(getStateLabel('pausedDL', 0.5, 0, 0)).toBe('Paused');
    });

    it('pausedUP (finished-then-stopped) → "Completed", matching qBittorrent\'s own WebUI', () => {
      expect(getStateLabel('pausedUP', 1, 0, 0)).toBe('Completed');
    });

    it('stoppedDL → "Stopped"', () => {
      expect(getStateLabel('stoppedDL', 0.5, 0, 0)).toBe('Stopped');
    });

    it('stoppedUP (finished-then-stopped) → "Completed", matching qBittorrent\'s own WebUI', () => {
      expect(getStateLabel('stoppedUP', 1, 0, 0)).toBe('Completed');
    });

    it('stoppedDL at 100% progress (qBittorrent state-machine gap) → "Completed"', () => {
      expect(getStateLabel('stoppedDL', 1, 0, 0)).toBe('Completed');
    });

    it('pausedDL at 100% progress (qBittorrent state-machine gap) → "Completed"', () => {
      expect(getStateLabel('pausedDL', 1, 0, 0)).toBe('Completed');
    });

    it('error → "Error"', () => {
      expect(getStateLabel('error', 0, 0, 0)).toBe('Error');
    });

    it('missingFiles → "Missing Files"', () => {
      expect(getStateLabel('missingFiles', 0, 0, 0)).toBe('Missing Files');
    });

    it('checkingDL → "Checking"', () => {
      expect(getStateLabel('checkingDL', 0.5, 0, 0)).toBe('Checking');
    });

    it('checkingUP → "Checking"', () => {
      expect(getStateLabel('checkingUP', 1, 0, 0)).toBe('Checking');
    });

    it('queuedDL → "Queued"', () => {
      expect(getStateLabel('queuedDL', 0, 0, 0)).toBe('Queued');
    });

    it('queuedUP → "Queued"', () => {
      expect(getStateLabel('queuedUP', 0, 0, 0)).toBe('Queued');
    });

    it('stalledDL → "Stalled DL"', () => {
      expect(getStateLabel('stalledDL', 0.5, 0, 0)).toBe('Stalled DL');
    });

    it('allocating → "Allocating"', () => {
      expect(getStateLabel('allocating', 0, 0, 0)).toBe('Allocating');
    });

    it('checkingResumeData → "Checking"', () => {
      expect(getStateLabel('checkingResumeData', 0, 0, 0)).toBe('Checking');
    });

    it('moving → "Moving"', () => {
      expect(getStateLabel('moving', 0.5, 0, 0)).toBe('Moving');
    });

    it('unknown state returns the raw state string', () => {
      expect(getStateLabel('somethingNew', 0, 0, 0)).toBe('somethingNew');
    });
  });
});

describe('hasEta', () => {
  it('returns true while downloading with a finite eta', () => {
    expect(hasEta(3600, 'downloading')).toBe(true);
  });

  it('returns false when complete', () => {
    expect(hasEta(3600, 'stoppedDL')).toBe(false);
  });

  it('returns false for the infinite-eta sentinel (8640000)', () => {
    expect(hasEta(8640000, 'downloading')).toBe(false);
  });

  it('returns false when eta is 0', () => {
    expect(hasEta(0, 'downloading')).toBe(false);
  });

  it('returns true for seeding state', () => {
    expect(hasEta(3600, 'uploading')).toBe(true);
  });

  it('returns true for stalledUP (seeding-time limit still counts down)', () => {
    expect(hasEta(3600, 'stalledUP')).toBe(true);
  });

  it('returns false when queued', () => {
    expect(hasEta(3600, 'queuedUP')).toBe(false);
  });

  it('returns true while checking a completed torrent', () => {
    expect(hasEta(3600, 'checkingUP')).toBe(true);
  });
});

describe('isActiveState', () => {
  it.each([
    'downloading',
    'forcedDL',
    'metaDL',
    'forcedMetaDL',
    'stalledDL',
    'uploading',
    'forcedUP',
    'stalledUP',
    'checkingUP',
    'checkingDL',
    'checkingResumeData',
  ])('%s is active', (state) => {
    expect(isActiveState(state)).toBe(true);
  });

  it.each([
    'stoppedDL',
    'stoppedUP',
    'pausedDL',
    'pausedUP',
    'queuedDL',
    'queuedUP',
    'moving',
    'allocating',
    'error',
    'missingFiles',
    'unknown',
  ])('%s is not active', (state) => {
    expect(isActiveState(state)).toBe(false);
  });
});

describe('isCompletedState', () => {
  it.each([
    'uploading',
    'stalledUP',
    'checkingUP',
    'pausedUP',
    'stoppedUP',
    'queuedUP',
    'forcedUP',
  ])('%s → true (matches qBittorrent isCompleted())', (state) => {
    expect(isCompletedState(state)).toBe(true);
  });

  it.each([
    'downloading',
    'forcedDL',
    'metaDL',
    'forcedMetaDL',
    'pausedDL',
    'stoppedDL',
    'queuedDL',
    'stalledDL',
    'checkingDL',
    'checkingResumeData',
    'error',
    'missingFiles',
    'allocating',
    'moving',
    'unknown',
  ])('%s → false', (state) => {
    expect(isCompletedState(state)).toBe(false);
  });
});

describe('isTorrentCompleted', () => {
  it('returns true for upload-side states regardless of progress', () => {
    expect(isTorrentCompleted('stalledUP', 1)).toBe(true);
  });

  it('returns true when progress is 100% even on a download-side state (qBittorrent leaves stopped-while-finished torrents on stoppedDL/pausedDL)', () => {
    expect(isTorrentCompleted('stoppedDL', 1)).toBe(true);
    expect(isTorrentCompleted('pausedDL', 1)).toBe(true);
  });

  it('returns false for a download-side state below 100% progress', () => {
    expect(isTorrentCompleted('stoppedDL', 0.5)).toBe(false);
    expect(isTorrentCompleted('downloading', 0.99)).toBe(false);
  });
});
