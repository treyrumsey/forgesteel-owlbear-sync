import { Space, Switch } from 'antd';
import { HeaderText } from '@/components/controls/header-text/header-text';
import { LivePanels } from '@/sync-steel/panels/live-panels';
import { useState } from 'react';

// The Live panels switch (src/sync-steel/panels/), saved on this device
export const SyncSteelLivePanelsSetting = () => {
	const [ on, setOn ] = useState<boolean>(LivePanels.isOn());

	return (
		<Space orientation='vertical' style={{ width: '100%' }}>
			<HeaderText level={2}>This device</HeaderText>
			<Space align='start'>
				<Switch
					checked={on}
					aria-label='Live panels'
					onChange={value => {
						LivePanels.set(value);
						setOn(value);
					}}
				/>
				<div>
					<b>Live panels</b>
					<div className='sync-steel-note'>
						An open Resources, Vitals or Inventory panel shows changes made on another device or in Owlbear straight away.
						Turn it off to use Forge Steel's original panels, which show them once reopened. Takes effect the next time a panel opens.
					</div>
				</div>
			</Space>
		</Space>
	);
};
