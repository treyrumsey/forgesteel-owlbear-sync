import { Alert, Button, Flex, List, Modal, Popconfirm, Space, Spin, Tag, Typography, Upload, notification } from 'antd';
import { CloudDownloadOutlined, CloudUploadOutlined, ReloadOutlined } from '@ant-design/icons';
import { GmRoom, SyncSteelDeviceApi } from '@/sync-steel/api/sync-steel-api';
import { useCallback, useEffect, useState } from 'react';
import { Expander } from '@/components/controls/expander/expander';
import { HeaderText } from '@/components/controls/header-text/header-text';
import { SyncSteelFiles } from '@/sync-steel/logic/sync-steel-files';

interface Props {
	api: SyncSteelDeviceApi;
}

// Remind the GM to take a copy off the server after a week
const EXPORT_REMINDER_DAYS = 7;

export const SyncSteelGmPanel = (props: Props) => {
	const { api } = props;
	const [ notify, notifyContext ] = notification.useNotification();
	const [ modal, modalContext ] = Modal.useModal();
	const [ room, setRoom ] = useState<GmRoom | null>(null);
	const [ snapshots, setSnapshots ] = useState<string[]>([]);
	const [ newCode, setNewCode ] = useState<string | null>(null);
	const [ busy, setBusy ] = useState<string | null>(null);
	const [ error, setError ] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		try {
			const [ r, s ] = await Promise.all([ api.gmRoom(), api.listSnapshots() ]);
			setRoom(r);
			setSnapshots(s);
			setError(null);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, [ api ]);

	useEffect(() => {
		// Load once the panel shows
		refresh();
	}, [ refresh ]);

	const run = async (key: string, action: () => Promise<void>) => {
		setBusy(key);
		try {
			await action();
		} catch (e) {
			notify.error({ title: 'That didn\'t work', description: e instanceof Error ? e.message : String(e), placement: 'top' });
		} finally {
			setBusy(null);
		}
	};

	const exportRoom = () => run('export', async () => {
		const file = await api.exportRoom();
		SyncSteelFiles.download(file.bytes, file.filename);
		await refresh();
	});

	// Every import is a dry run first, confirmed by the GM
	const importBytes = async (bytes: ArrayBuffer, source: string) => {
		const preview = await api.importRoom(bytes, true);
		if (SyncSteelFiles.importChangesNothing(preview)) {
			notify.info({ title: 'Nothing to restore', description: `The room already matches ${source}.`, placement: 'top' });
			return;
		}
		const confirmed = await modal.confirm({
			title: `Restore from ${source}?`,
			content: (
				<Space orientation='vertical'>
					<div className='ds-text'>This would change the room as follows. Nothing is deleted, and heroes added since then stay.</div>
					{SyncSteelFiles.describeImport(preview).map(line => <div key={line} className='ds-text'>{line}</div>)}
				</Space>
			),
			okText: 'Restore'
		});
		if (!confirmed) {
			return;
		}
		const result = await api.importRoom(bytes, false);
		notify.success({ title: 'Restored', description: SyncSteelFiles.describeImport(result).join('. '), placement: 'top' });
		await refresh();
	};

	const importFile = (file: File) => {
		run('import', async () => importBytes(await file.arrayBuffer(), file.name));
		return false;
	};

	const restoreSnapshot = (date: string) => run(`restore-${date}`, async () => {
		const file = await api.exportSnapshot(date);
		await importBytes(file.bytes, `the ${date} snapshot`);
	});

	const downloadSnapshot = (date: string) => run(`download-${date}`, async () => {
		const file = await api.exportSnapshot(date);
		SyncSteelFiles.download(file.bytes, file.filename);
	});

	const rotateCode = () => run('rotate', async () => {
		setNewCode(await api.rotateJoinCode());
		await refresh();
	});

	const renameSeat = (seatId: string, name: string) => run(`rename-${seatId}`, async () => {
		if (name.trim()) {
			await api.renameSeat(seatId, name.trim());
			await refresh();
		}
	});

	const revokeDevice = (deviceId: string) => run(`revoke-${deviceId}`, async () => {
		await api.revokeDevice(deviceId);
		await refresh();
	});

	if (error) {
		return <Alert type='error' showIcon={true} title={'Couldn\'t load the GM tools'} description={error} action={<Button onClick={refresh}>Retry</Button>} />;
	}

	if (!room) {
		return <Spin />;
	}

	const days = SyncSteelFiles.daysSince(room.room.lastExportAt, Date.now());
	const exportOverdue = (days === null) || (days > EXPORT_REMINDER_DAYS);

	return (
		<Space orientation='vertical' style={{ width: '100%' }} size='middle'>
			<HeaderText level={1} extra={<Button type='text' title='Refresh' icon={<ReloadOutlined />} onClick={refresh} />}>GM tools</HeaderText>
			<Expander title='Backups' expandedByDefault={true}>
				<Space orientation='vertical' style={{ width: '100%' }}>
					<Alert
						type={exportOverdue ? 'warning' : 'success'}
						showIcon={true}
						title={`Last export: ${SyncSteelFiles.formatDate(room.room.lastExportAt)}`}
						description={'An export is the room\'s copy outside the server: every seat, hero and homebrew sourcebook. Download one after each session and keep it somewhere safe.'}
					/>
					<Flex gap={10} wrap={true}>
						<Button type='primary' icon={<CloudDownloadOutlined />} loading={busy === 'export'} onClick={exportRoom}>Download export</Button>
						<Upload accept='.gz,.json' showUploadList={false} beforeUpload={importFile}>
							<Button icon={<CloudUploadOutlined />} loading={busy === 'import'}>Restore from an export…</Button>
						</Upload>
					</Flex>
					<div className='ds-text'>
						<b>Daily snapshots</b>: the server keeps a copy of each of the last 14 days. Restoring one shows what would change before anything does.
					</div>
					{
						snapshots.length === 0 ?
							<div className='ds-text dimmed-text'>No snapshots yet; the first is taken within a day.</div>
							:
							<List
								size='small'
								dataSource={snapshots}
								renderItem={date => (
									<List.Item
										actions={[
											<Button key='download' size='small' loading={busy === `download-${date}`} onClick={() => downloadSnapshot(date)}>Download</Button>,
											<Button key='restore' size='small' loading={busy === `restore-${date}`} onClick={() => restoreSnapshot(date)}>Restore…</Button>
										]}
									>
										{date}
									</List.Item>
								)}
							/>
					}
				</Space>
			</Expander>
			<Expander title='Join code'>
				<Space orientation='vertical' style={{ width: '100%' }}>
					<div className='ds-text'>
						The join code can't be shown again. If you've lost it, or it was shared too widely, make a new one. Devices that already joined stay signed in.
					</div>
					{
						newCode ?
							<Alert type='success' showIcon={true} title={<>New join code: <Typography.Text className='sync-steel-secret' copyable={true}>{newCode}</Typography.Text></>} />
							: null
					}
					<Popconfirm title='Make a new join code?' description='The old code stops working.' okText='New code' onConfirm={rotateCode}>
						<Button loading={busy === 'rotate'}>New join code</Button>
					</Popconfirm>
					<div className='ds-text dimmed-text'>Last changed: {SyncSteelFiles.formatDate(room.room.codeRotatedAt ?? room.room.createdAt)}</div>
				</Space>
			</Expander>
			<Expander title='Seats and devices' expandedByDefault={true}>
				<Space orientation='vertical' style={{ width: '100%' }} size='middle'>
					<div className='ds-text'>
						Disconnect a lost or old device to sign it out; its seat and heroes stay. The player rejoins on a new device by picking their seat.
					</div>
					{
						room.seats.map(seat => (
							<div key={seat.id} className='sync-steel-seat'>
								<Flex align='center' gap={8}>
									<Typography.Text strong={true} editable={{ onChange: name => { if (name !== seat.name) { renameSeat(seat.id, name); } }, maxLength: 60 }}>
										{seat.name}
									</Typography.Text>
									{seat.isGm ? <Tag color='gold'>GM</Tag> : null}
								</Flex>
								<div className='ds-text dimmed-text'>
									Heroes: {seat.heroes.length === 0 ? 'none yet' : seat.heroes.map(h => h.name).join(', ')}
								</div>
								<List
									size='small'
									dataSource={seat.devices}
									locale={{ emptyText: 'No devices' }}
									renderItem={device => (
										<List.Item
											actions={
												(device.current || device.revokedAt)
													? []
													: [
														<Popconfirm
															key='revoke'
															title={`Disconnect ${device.label}?`}
															description={'It\'s signed out at its next request. This can\'t be undone; the player can join again with the code.'}
															okText='Disconnect'
															okButtonProps={{ danger: true }}
															onConfirm={() => revokeDevice(device.id)}
														>
															<Button size='small' danger={true} loading={busy === `revoke-${device.id}`}>Disconnect</Button>
														</Popconfirm>
													]
											}
										>
											<Space orientation='vertical' size={0}>
												<Flex gap={6} align='center'>
													<span className={device.revokedAt ? 'sync-steel-revoked' : ''}>{device.label}</span>
													{device.current ? <Tag color='blue'>this device</Tag> : null}
													{device.revokedAt ? <Tag>disconnected</Tag> : null}
												</Flex>
												<span className='ds-text dimmed-text'>Last used: {SyncSteelFiles.formatDate(device.lastUsedAt)}</span>
											</Space>
										</List.Item>
									)}
								/>
							</div>
						))
					}
				</Space>
			</Expander>
			{notifyContext}
			{modalContext}
		</Space>
	);
};
