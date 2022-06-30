import * as vscode from 'vscode';
// import * as hippo from '@fermyon/hippo';
import got from 'got';

import { err, Errorable, isErr, isOk, ok } from '../errorable';
import { ensureSpinInstalled } from '../installer';
import { shell } from '../utils/shell';
import { ChildProcess, spawn } from 'child_process';
import { sleep } from '../utils/sleep';
import { longRunning } from '../longrunning';

let ACTIVE_INSTANCE: LocalInstance | null = null;

export async function startLocalFermyon() {
    if (ACTIVE_INSTANCE) {
        vscode.window.showInformationMessage("Already running");
    }

    // const osCheck = await checkOS();
    // if (isErr(osCheck)) {
    //     vscode.window.showErrorMessage(osCheck.message);
    //     return;
    // }

    const spinPath = await ensureSpinInstalled();
    if (isErr(spinPath)) {
        vscode.window.showErrorMessage(`Spin is not available: {}`, spinPath.message);
        return;
    }
    process.env["Spin__BinaryPath"] = spinPath.value;

    const prereqsCheck = await checkPrerequisites();
    if (isErr(prereqsCheck)) {
        vscode.window.showErrorMessage(prereqsCheck.message);
        return;
    }

    const pw = await vscode.window.showInputBox({prompt: 'sudo password'});
    if (!pw) {
        return;
    }

    const localInstallerPath = '/home/ivan/github/fermyon-installer/local';
    const dataDir = '/home/ivan/github/fermyon-installer/local/data';

    const instance = new LocalInstance();

    // We're going to need
    // * The installer repo
    //   - better to recapitulate the setup script in TS rather than shelling to bash?
    await longRunning("Starting Consul and Nomad", async () => {
        // SUDOING CONSUL CAUSES WEIRD ERRORS AND I DON'T KNOW WHY
        // const consulProcess = spawn('sudo', ['-S', '--preserve-env=PATH,Spin__BinaryPath', 'consul', "agent", "-dev", "-config-file", `${localInstallerPath}/etc/consul.hcl`, '-data-dir', `${dataDir}/data/consul`, '-bootstrap-expect', '1']);
        // consulProcess.stderr.on('data', () =>
        //     consulProcess.stdin.write(pw + '\n')
        // );
        const consulProcess = spawn('consul', ["agent", "-dev", "-config-file", `${localInstallerPath}/etc/consul.hcl`, '-data-dir', `${dataDir}/data/consul`, '-bootstrap-expect', '1']);
        instance.setConsul(consulProcess);

        const nomadProcess = spawn('sudo', ['-S', '--preserve-env=PATH,Spin__BinaryPath', 'nomad', "agent", "-dev", "-config", `${localInstallerPath}/etc/nomad.hcl`, '-data-dir', `${dataDir}/data/nomad`, '-consul-address', '127.0.0.1:8500']);
        nomadProcess.stderr.on('data', () =>
            nomadProcess.stdin.write(pw + '\n')
        );
        instance.setNomad(nomadProcess);
        
        await nomadReady();
    });

    await vscode.window.showInformationMessage("Consul and Nomad ready");

    // // TODO: would it be better to start the job without the interactive monitor (fire
    // // and forget style) and poll in VS Code or something?
    // const traefiksr = await longRunning("Starting Traefik", () =>
    //     shell.exec(`nomad run ${localInstallerPath}/job/traefik.nomad`)
    // );
    // if (isErr(traefiksr) || traefiksr.value.code !== 0) {
    //     const msg = isErr(traefiksr) ?
    //         traefiksr.message :
    //         `Exit ${traefiksr.value.code}: ${traefiksr.value.stderr}`;
    //     await Promise.all([
    //         instance.stop(),
    //         vscode.window.showErrorMessage(`TRAEFIK WOE ${msg}`),
    //     ]);
    //     return;
    // }

    const t = await longRunning("Starting Traefik", () =>
        runJob('traefik', '', localInstallerPath)
    );
    if (isErr(t)) {
        await Promise.all([
            // instance.stop(),
            vscode.window.showErrorMessage(`TRAEFIK WOE ${t.message}`),
        ]);
        return;
    }

    const arch = 'amd64';  // TODO: <--
    const bindleos = 'linux';
    const hippoos = 'linux';
    const bindleUrl = 'http://bindle.local.fermyon.link/v1';
    const hippoUrl = 'http://hippo.local.fermyon.link';

    const b = await longRunning("Starting Bindle", () =>
        runJob('bindle', `-var="os=${bindleos}" -var="arch=${arch}"`, localInstallerPath)
    );
    if (isErr(b)) {
        await Promise.all([
            // instance.stop(),
            vscode.window.showErrorMessage(`BINDLE WOE ${b.message}`),
        ]);
        return;
    }

    const h = await longRunning("Starting Hippo", () =>
        runJob('hippo', `-var="os=${hippoos}"`, localInstallerPath)
    );
    if (isErr(h)) {
        await Promise.all([
            // instance.stop(),
            vscode.window.showErrorMessage(`HIPPO WOE ${h.message}`),
        ]);
        return;
    }

    // const bindlesr = await longRunning("Starting Bindle", () =>
    //     shell.exec(`nomad run -var="os=${bindleos}" -var="arch=${arch}" ${localInstallerPath}/job/bindle.nomad`)
    // );
    // if (isErr(bindlesr) || bindlesr.value.code !== 0) {
    //     const msg = isErr(bindlesr) ?
    //         bindlesr.message :
    //         `Exit ${bindlesr.value.code}: ${bindlesr.value.stderr}`;
    //     await Promise.all([
    //         instance.stop(),
    //         vscode.window.showErrorMessage(`OH NO BINDLE ${msg}`),
    //     ]);
    //     return;
    // }
    // await vscode.window.showInformationMessage("Bindle ready");

    // const hipposr = await longRunning("Starting Hippo", () =>
    //     shell.exec(`nomad run -var="os=${hippoos}" ${localInstallerPath}/job/hippo.nomad`)
    // );
    // if (isErr(hipposr) || hipposr.value.code !== 0) {
    //     const msg = isErr(hipposr) ?
    //         hipposr.message :
    //         `Exit ${hipposr.value.code}: ${hipposr.value.stderr}`;
    //     await Promise.all([
    //         instance.stop(),
    //         vscode.window.showErrorMessage("OH NO HIPPO"),
    //     ]);
    //     return;
    // }
    // await vscode.window.showInformationMessage("Hippo ready");

    ACTIVE_INSTANCE = instance;

    await longRunning("Waiting for Hippo to be ready", () =>
        hippoReady(hippoUrl)
    );

    await vscode.window.showInformationMessage("TADA READY");

    // * the Hippo CLI to register an account?  Can use browser I guess but then we have faff with getting username and password
    //   - oh wait is there a TS client for Hippo?  NO BUT THERE IS A JS ONE
    // * Oh no it's going to want to sudo (on Linux at least)

    // const url = "http://hippo.local.fermyon.link";
    // const cfg: hippo.Configuration = new hippo.Configuration({ basePath: url });
    // const acct = new hippo.AccountApi(cfg);
    // const resp = await acct.apiAccountPost({userName: "plop", password: "Pl0p!Pl0p"});
    // console.log(resp.status);
    // console.log(resp.data);

}

async function runJob(name: string, extras: string, localInstallerPath: string): Promise<Errorable<null>> {
    const sr = await shell.exec(`nomad run ${extras} -detach ${localInstallerPath}/job/${name}.nomad`);
    if (isErr(sr)) {
        return err("Failed to run Nomad");
    }
    if (sr.value.code !== 0) {
        return err(`Failed to schedule job: ${sr.value.stderr}`);
    }

    let statusFailCount = 0;
    for (;;) {
        sleep(1000);
        const ssr = await shell.exec(`nomad job status ${name}`);
        if (isErr(ssr) || ssr.value.code !== 0) {
            ++statusFailCount;
            if (statusFailCount > 5) {
                if (isErr(sr)) {
                    return err("Repeatedly failed to run Nomad to get job status");
                }
                if (sr.value.code !== 0) {
                    return err(`Repeatedly failed to get job status: ${sr.value.stderr}`);
                }
            }
        } else {
            statusFailCount = 0;
            if (isHealthy(name, ssr.value.stdout)) {
                return ok(null);
            }
        }
    }
}

function isHealthy(name: string, nomadStatusText: string): boolean {
    const lines = nomadStatusText.split('\n').map((s) => s.trim()).filter((s) => s.length > 0);
    const deployedSection = skipWhile(lines, (line) => line !== "Deployed");
    const statusLine = deployedSection.find((line) => line.startsWith(name));
    if (!statusLine) {
        return false;
    }
    const statusBits = statusLine.split(' ').filter((bit) => bit.length > 0);
    const [_name, _desired, placed, healthy, unhealthy, _progress] = statusBits;
    return (placed ==='1' && healthy === '1' && unhealthy === '0');
}

function skipWhile<T>(source: T[], predicate: (arg: T) => boolean): T[] {
    const index = source.findIndex((s) => !predicate(s));
    if (index < 0) {
        return [];
    }
    return source.slice(index);
}

export async function stopLocalFermyon() {
    if (ACTIVE_INSTANCE) {
        await ACTIVE_INSTANCE.stop();
        ACTIVE_INSTANCE = null;
    }
}

async function nomadReady(): Promise<void> {
    for (;;) {
        const sr = await shell.exec('nomad server members');
        if (isOk(sr)) {
            if (sr.value.stdout.includes('alive')) {
                return;
            }
        }
        await sleep(1000);
    }
}

async function hippoReady(hippoUrl: string): Promise<void> {
    for (;;) {
        try {
            const resp = await got(`${hippoUrl}/healthz`, {});
            if (resp.body.includes('Healthy')) {
                return;
            }
        } catch {
            // swallow.  It's probably some silly 404
        }

        await sleep(1000);
    }
}

async function checkOS(): Promise<Errorable<null>> {
    const sr = await shell.exec('lsb_release -r -s');
    if (isOk(sr) && sr.value.code === 0) {
        const rel = sr.value.stdout;
        const [major, _rest] = rel.split('.', 2);
        const majorNum = Number.parseInt(major);
        if (majorNum < 20) {
            return err('Fermyon requires Ubuntu 20 or above');
        } else {
            return ok(null);
        }
    } else {
        return err('Unable to confirm compatible OS version');
    }
}

async function checkPrerequisites(): Promise<Errorable<null>> {
    const nomadPresent = await isProgramPresent('nomad');
    const consulPresent = await isProgramPresent('consul');

    if (nomadPresent && consulPresent) {
        return ok(null);
    }

    if (nomadPresent && !consulPresent) {
        return err('Fermyon requires Consul which is not present. See https://www.consul.io/docs/install for instructions.');
    }

    if (!nomadPresent && consulPresent) {
        return err('Fermyon requires Nomad which is not present. See https://www.nomadproject.io/docs/install for instructions.');
    }

    return err('Fermyon requires Nomad and Consul which are not present. See https://github.com/fermyon/installer/tree/main/local for links.');
}

async function isProgramPresent(program: string): Promise<boolean> {
    const sr = await shell.exec(`${[program]} --version`);
    return (sr.succeeded && sr.value.code === 0);
}

class LocalInstance {
    private nomadProcess: ChildProcess | undefined;
    private consulProcess: ChildProcess | undefined;

    constructor() {
        this.nomadProcess = undefined;
        this.consulProcess = undefined;        
    }

    setNomad(cp: ChildProcess) {
        this.nomadProcess = cp;
    }

    setConsul(cp: ChildProcess) {
        this.consulProcess = cp;
    }

    async stop() {
        // This no longer works because the processes are audo
        if (this.nomadProcess && !this.nomadProcess.killed) {
            this.nomadProcess.kill();
        }
        if (this.consulProcess) {
            this.consulProcess.kill();
        }
    }
}

enum StopResult {
    NoInstanceRunning,
    Stopped,
    StopFailed,
}

async function tryStop(instanceToStop: ChildProcess | undefined): Promise<StopResult> {
    if (!instanceToStop || instanceToStop.killed) {
        return StopResult.NoInstanceRunning;
    }
    const killed = instanceToStop.kill("SIGTERM")
        || instanceToStop.kill("SIGQUIT")
        || instanceToStop.kill("SIGKILL");
    if (killed) {
        await awaitNotRunning(instanceToStop);
        if (isRunning(instanceToStop)) {
            return StopResult.StopFailed;
        } else {
            return StopResult.Stopped;
        }
    } else {
        return StopResult.StopFailed;
    }
}

function isRunning(instance: ChildProcess | null): boolean {
    return instance !== null &&
        instance.exitCode === null &&
        !instance.killed;
}

async function awaitNotRunning(instance: ChildProcess) {
    if (isRunning(instance)) {
        for (let i = 0; i < 20; ++i) {
            if (isRunning(instance)) {
                break;
            }
            sleep(50);
        }
    }
}