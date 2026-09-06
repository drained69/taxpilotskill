import React from 'react';
import { registerRoot } from 'remotion';
import { Composition } from 'remotion';
import { TaxPilotIntro } from './TaxPilotIntro';

export const RemotionRoot = () => (
  <Composition
    id="TaxPilotIntro"
    component={TaxPilotIntro}
    durationInFrames={30 * 45}
    fps={30}
    width={1920}
    height={1080}
    defaultProps={{ product: 'TaxPilot' }}
  />
);

registerRoot(RemotionRoot);
