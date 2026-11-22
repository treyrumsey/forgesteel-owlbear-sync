import { Alert, Space, Tabs } from 'antd';
import { AppFooter, FooterParams } from '@/components/panels/app-footer/app-footer';
import { AppHeader } from '@/components/panels/app-header/app-header';
import { ConnectionSettings } from '@/models/connection-settings';
import { ErrorBoundary } from '@/components/controls/error-boundary/error-boundary';
import { SyncSteelConnectedPanel } from '@/sync-steel/components/connected-panel';
import { SyncSteelConnection } from '@/sync-steel/logic/sync-steel-connection';
import { SyncSteelCreateRoomPanel } from '@/sync-steel/components/create-room-panel';
import { SyncSteelJoinPanel } from '@/sync-steel/components/join-panel';
import { getSyncSteelApiHost } from '@/sync-steel/config';

import './sync-steel-page.scss';

interface Props {
	params: FooterParams;
	connectionSettings: ConnectionSettings;
	persistConnectionSettings: (settings: ConnectionSettings) => Promise<unknown>;
}

// Joining a room, and the GM's tools. Joining saves the device token as Forge Steel's manual
// Warehouse connection, then reloads so every hero and sourcebook loads from the room.
export const SyncSteelPage = (props: Props) => {
	const host = getSyncSteelApiHost();
	const connected = SyncSteelConnection.isConnected(props.connectionSettings, host);

	const save = async (settings: ConnectionSettings) => {
		await props.persistConnectionSettings(settings);
		window.location.reload();
	};

	return (
		<ErrorBoundary>
			<div className='sync-steel-page'>
				<AppHeader subheader='Sync Steel' />
				<div className='sync-steel-page-content'>
					<div className='sync-steel-column'>
						{
							connected ?
								<SyncSteelConnectedPanel
									host={host}
									deviceToken={props.connectionSettings.warehouseToken}
									onDisconnect={() => save(SyncSteelConnection.disconnect())}
								/>
								:
								<Space orientation='vertical' style={{ width: '100%' }} size='middle'>
									<div className='ds-text'>
										Sync Steel keeps your heroes in your group's room, so they're on every device you join from and safe if a device is lost.
									</div>
									{
										SyncSteelConnection.usesOtherStorage(props.connectionSettings, host) ?
											<Alert
												type='warning'
												showIcon={true}
												title='This browser uses other remote storage'
												description='Joining a room replaces its current Warehouse or Patreon connection.'
											/>
											: null
									}
									<Tabs
										items={[
											{ key: 'join', label: 'Join a room', children: <SyncSteelJoinPanel host={host} onJoined={token => save(SyncSteelConnection.create(host, token))} /> },
											{ key: 'create', label: 'Create a room (GM)', children: <SyncSteelCreateRoomPanel host={host} onJoined={token => save(SyncSteelConnection.create(host, token))} /> }
										]}
									/>
								</Space>
						}
						<div className='ds-text dimmed-text sync-steel-note'>
							Sync Steel is an unofficial fork of <a href='https://forgesteel.net' target='_blank' rel='noreferrer'>Forge Steel</a>, run for one gaming group. It isn't made or supported by Forge Steel's author.
						</div>
					</div>
				</div>
				{/* 'clocktower' highlights none of the footer's navigation buttons, like this page */}
				<AppFooter page='clocktower' hero={null} params={props.params} />
			</div>
		</ErrorBoundary>
	);
};
