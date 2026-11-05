import { useCallback, useEffect, useState } from 'react';
import { keygate, isKeygateError } from 'electron-plugin-keygate/renderer';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';

type License = Awaited<ReturnType<typeof keygate.getLicense>>;

const server = new URLSearchParams(window.location.search).get('server') ?? 'not configured';

function formatTime(value: string | null): string {
	if (!value) {
		return 'never';
	}
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export default function App() {
	const [key, setKey] = useState('');
	const [license, setLicense] = useState<License>(null);
	const [planName, setPlanName] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		setLicense(await keygate.getLicense());
	}, []);

	/** Every call goes through the same envelope, so every failure has a code. */
	const run = useCallback(
		async (action: () => Promise<unknown>) => {
			setBusy(true);
			setError(null);
			try {
				await action();
				await refresh();
			} catch (err) {
				setError(isKeygateError(err) ? `${err.code}: ${err.detail}` : String(err));
			} finally {
				setBusy(false);
			}
		},
		[refresh],
	);

	useEffect(() => {
		void (async () => {
			const cached = await keygate.getLicenseKey().catch(() => null);
			if (cached) {
				setKey(cached);
			}
			await refresh();
		})();
	}, [refresh]);

	const activate = () => {
		const value = key.trim();
		if (!value) {
			setError('enter a license key first');
			return;
		}
		void run(async () => {
			await keygate.activate({ key: value, label: 'keygate demo' });
			// The signed token carries the plan id; the server knows its name.
			const entitlements = await keygate.getEntitlements({}).catch(() => null);
			setPlanName(entitlements?.planName ?? null);
		});
	};

	return (
		<main className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-3 p-5">
			<h1 className="text-lg font-semibold tracking-tight">electron-plugin-keygate</h1>

			<Card className="gap-3 py-4">
				<CardHeader>
					<CardTitle className="text-base">Activate</CardTitle>
				</CardHeader>
				<CardContent className="space-y-3">
					<div className="space-y-2">
						<Label htmlFor="key">License key</Label>
						<Input
							id="key"
							type="password"
							value={key}
							autoComplete="off"
							spellCheck={false}
							placeholder="KG-XXXX-XXXX-XXXX-XXXX"
							onChange={(event) => setKey(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === 'Enter') {
									activate();
								}
							}}
						/>
					</div>
					<Button className="w-full" disabled={busy} onClick={activate}>
						{busy ? 'Working…' : 'Activate'}
					</Button>
					{error ? (
						<p className="text-sm text-destructive" role="alert">
							{error}
						</p>
					) : null}
				</CardContent>
			</Card>

			<Card className="gap-3 py-4">
				<CardHeader>
					<CardTitle className="text-base">License</CardTitle>
				</CardHeader>
				<CardContent className="space-y-3">
					{license ? (
						<>
							<div className="flex items-center gap-2">
								<Badge variant={license.valid ? 'default' : 'destructive'}>
									{license.valid ? 'Licensed' : 'Not valid'}
								</Badge>
								{license.offline ? <Badge variant="outline">offline · cached</Badge> : null}
							</div>

							<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
								<dt className="text-muted-foreground">Plan</dt>
								<dd>{planName ?? license.planName ?? license.planId}</dd>
								<dt className="text-muted-foreground">Device</dt>
								<dd className="font-mono text-xs">{license.identifier}</dd>
								<dt className="text-muted-foreground">Expires</dt>
								<dd>{formatTime(license.expiresAt)}</dd>
							</dl>

							{license.entitlements.length > 0 ? (
								<div className="flex flex-wrap gap-1.5">
									{license.entitlements.map((name) => (
										<Badge key={name} variant="secondary">
											{name}
										</Badge>
									))}
								</div>
							) : (
								<p className="text-sm text-muted-foreground">No entitlements on this license.</p>
							)}
						</>
					) : (
						<p className="text-sm text-muted-foreground">No license on this machine yet.</p>
					)}

					<Separator />

					<div className="flex flex-wrap gap-2">
						<Button variant="outline" size="sm" disabled={busy} onClick={() => void run(() => keygate.verify({}))}>
							Verify
						</Button>
						<Button variant="outline" size="sm" disabled={busy} onClick={() => void run(() => keygate.deactivate({}))}>
							Deactivate
						</Button>
						<Button variant="ghost" size="sm" disabled={busy} onClick={() => void run(() => keygate.resetLicense())}>
							Reset
						</Button>
					</div>
				</CardContent>
			</Card>

			<footer className="mt-auto text-xs text-muted-foreground">
				Server <span className="font-mono">{server}</span>
			</footer>
		</main>
	);
}
