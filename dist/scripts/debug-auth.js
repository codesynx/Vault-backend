import { TdlibClient, initializeTdlib } from '../lib/tdlib/client.js';
import { resolve } from 'path';
async function main() {
    const phoneNumber = process.argv[2];
    if (!phoneNumber) {
        console.error('Please provide a phone number as an argument: npm run dev src/scripts/debug-auth.ts <phone_number>');
        process.exit(1);
    }
    console.log(`Starting debug auth for ${phoneNumber}...`);
    console.log('NOTE: \x1b[33mPlease ensure you are checking the "Service Notifications" chat in Telegram.\x1b[0m');
    await initializeTdlib();
    // Create a temporary session for debugging
    const sessionPath = resolve('tdlib_sessions', 'debug_session_' + Date.now());
    const client = new TdlibClient(sessionPath);
    await client.initialize({
        device_model: 'DebugScript',
        application_version: '1.0.0-debug'
    });
    console.log('Client initialized. Checking state...');
    // Handler for state updates
    const handleState = async (stateStr, stateObj) => {
        console.log('>>> Processing State:', stateStr);
        if (stateStr === 'authorizationStateWaitPhoneNumber') {
            console.log('Sending phone number:', phoneNumber);
            try {
                await client.setPhoneNumber(phoneNumber);
                console.log('Phone number sent.');
            }
            catch (err) {
                console.error('Failed to set phone number:', err);
            }
        }
        else if (stateStr === 'authorizationStateWaitCode') {
            console.log('\nSUCCESS! Telegram is waiting for code.');
            if (stateObj?.code_info) {
                const type = stateObj.code_info.type?._;
                console.log('Code sent via:', type);
                if (type === 'authenticationCodeTypeTelegramMessage') {
                    console.log('NOTE: The code was sent to your OTHER Telegram device (e.g. Desktop or Mobile app), NOT via SMS yet.');
                }
                console.log('Code info:', JSON.stringify(stateObj.code_info, null, 2));
            }
            console.log('\nType "resend" to request SMS (might need to wait), or "quit" to exit.');
        }
        else if (stateStr === 'authorizationStateClosed') {
            console.log('Session closed.');
            process.exit(1);
        }
        else if (stateStr === 'authorizationStateReady') {
            console.log('Already logged in!');
            process.exit(0);
        }
    };
    // Monitor updates
    client.on('updateAuthorizationState', (update) => {
        const state = update.authorization_state;
        // console.log('>>> Auth State Update Event:', state?._);
        handleState(state?._, state);
    });
    // Check current state immediately
    const currentState = client.getAuthState();
    console.log('Initial State after init:', currentState);
    // We need to construct a dummy state object for the handler if we don't have the full object, 
    // but for WaitPhoneNumber we generally don't need extra details. 
    // However, it's safer to just call the handler with the string.
    await handleState(currentState, { _: currentState });
    // Keep alive and handle input
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', async (text) => {
        const input = text.toString().trim();
        if (input === 'quit') {
            await client.close();
            process.exit(0);
        }
        else if (input === 'resend') {
            console.log('Attempting to resend code...');
            try {
                await client.resendCode();
                console.log('Resend requested.');
            }
            catch (err) {
                console.error('Error resending code:', err);
            }
        }
    });
    // Keep alive
    await new Promise(resolve => setTimeout(resolve, 60000));
    console.log('Timeout reached.');
    await client.close();
}
main().catch(err => {
    console.error('Unhandled error:', err);
    process.exit(1);
});
//# sourceMappingURL=debug-auth.js.map