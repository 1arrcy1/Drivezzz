//! Drivezzz ride escrow.
//!
//! A ride's money waits in its own escrow until the server picks one of three outcomes: pay out (the driver
//! gets the price minus Drivezzz's fee), 50/50, or refund. Money only ever goes to the rider who paid, the
//! ride's driver and the fee address. If nothing is decided before the timeout, anyone can refund the rider.
//! Nothing a rider does to their own wallet can stop the driver being paid: without a usable USDC account, their part
//! waits in the vault for them, and what's left in the escrow is all theirs from then on.
//!
//! Instructions (first byte of the data):
//!   0 init    [admin s, config w, programdata, system]                     bump, server, fee, mint
//!   1 update  [admin s, config w]                                          server, fee, admin
//!   2 pay     [payer s w, config, escrow w, system]
//!             + USDC: [mint, payer token w, vault w, token program]        id, bump, vault bump, kind, driver,
//!                                                                          driver amount, fee amount
//!   3 settle  [server s w, config, escrow w, payer w, driver w, fee w]
//!             + USDC: [vault w, payer token w, driver token w, fee token w, token program]   outcome
//!   4 expire  [anyone s w, escrow w, payer w]
//!             + USDC: [vault w, payer token w, token program]
#![no_std]

use pinocchio::{
    cpi::{Seed, Signer},
    error::ProgramError,
    no_allocator, nostd_panic_handler, program_entrypoint,
    sysvars::{clock::Clock, rent::Rent, Sysvar},
    AccountView, Address, ProgramResult,
};
use pinocchio_system::instructions::CreateAccount;
use pinocchio_token::instructions::{CloseAccount, InitializeAccount3, Transfer};

program_entrypoint!(process, 12);
no_allocator!();
nostd_panic_handler!();

const SYSTEM: Address = Address::new_from_array([0; 32]);
const TOKEN: Address = pinocchio_token::ID;
const LOADER: Address = Address::from_str_const("BPFLoaderUpgradeab1e11111111111111111111111");

/// Paid by the rider into each escrow; it pays back whoever sends the settle or expire transaction (one signature).
const ALLOWANCE: u64 = 5_000;
#[cfg(feature = "devnet")]
const TIMEOUT: i64 = 10 * 60;
#[cfg(not(feature = "devnet"))]
const TIMEOUT: i64 = 30 * 24 * 60 * 60;

// Config: kind, bump, admin, server, fee address, USDC mint.
const CONFIG: u8 = 1;
const CONFIG_LEN: usize = 130;
// Escrow: kind, bump, vault bump, coin (0 SOL, 1 USDC), id, payer, driver, mint, driver amount, fee amount, created at.
const ESCROW: u8 = 2;
const ESCROW_LEN: usize = 140;
const TOKEN_ACCOUNT_LEN: usize = 165;

// Errors, by which check failed.
const BAD_ACCOUNT: u32 = 1;
const NOT_ALLOWED: u32 = 2;
const BAD_DATA: u32 = 3;
const TOO_EARLY: u32 = 4;
const BAD_AMOUNT: u32 = 5;

fn err(code: u32) -> ProgramError {
    ProgramError::Custom(code)
}

fn process(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let (tag, data) = data.split_first().ok_or(err(BAD_DATA))?;
    match tag {
        0 => init(program_id, accounts, data),
        1 => update(program_id, accounts, data),
        2 => pay(program_id, accounts, data),
        3 => settle(program_id, accounts, data),
        4 => expire(program_id, accounts, data),
        _ => Err(err(BAD_DATA)),
    }
}

/// Sets up the config once. Only the program's upgrade authority may, so nobody can take it over after the deploy.
fn init(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let [admin, config, programdata, system, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if data.len() != 97 {
        return Err(err(BAD_DATA));
    }
    if system.address() != &SYSTEM {
        return Err(err(BAD_ACCOUNT));
    }
    let (expected, _) = Address::find_program_address(&[program_id.as_array()], &LOADER);
    if programdata.address() != &expected || !programdata.owned_by(&LOADER) {
        return Err(err(BAD_ACCOUNT));
    }
    {
        // ProgramData: tag 3, slot, then Some(upgrade authority).
        let pd = programdata.try_borrow()?;
        if !admin.is_signer() || pd.len() < 45 || pd[0..4] != [3, 0, 0, 0] || pd[12] != 1 || pd[13..45] != admin.address().as_array()[..] {
            return Err(err(NOT_ALLOWED));
        }
    }
    let bump = [data[0]];
    if pda(&[b"config", &bump], program_id)? != *config.address() {
        return Err(err(BAD_ACCOUNT));
    }
    let seeds = [Seed::from(b"config"), Seed::from(&bump)];
    CreateAccount {
        from: admin,
        to: config,
        lamports: Rent::get()?.try_minimum_balance(CONFIG_LEN)?,
        space: CONFIG_LEN as u64,
        owner: program_id,
    }
    .invoke_signed(&[Signer::from(&seeds[..])])?;
    let mut d = config.try_borrow_mut()?;
    d[0] = CONFIG;
    d[1] = bump[0];
    d[2..34].copy_from_slice(admin.address().as_array());
    d[34..130].copy_from_slice(&data[1..97]);
    Ok(())
}

/// The admin changes the server key, the fee address or the admin. The USDC mint never changes.
fn update(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let [admin, config, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if data.len() != 96 {
        return Err(err(BAD_DATA));
    }
    check(config, program_id, CONFIG, CONFIG_LEN)?;
    let mut d = config.try_borrow_mut()?;
    if !admin.is_signer() || d[2..34] != admin.address().as_array()[..] {
        return Err(err(NOT_ALLOWED));
    }
    d[34..98].copy_from_slice(&data[0..64]);
    d[2..34].copy_from_slice(&data[64..96]);
    Ok(())
}

/// The rider pays a ride into its own escrow. The escrow's address comes from a random id the server makes for
/// this payment, so one id can only have one escrow at a time.
fn pay(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let [payer, config, escrow, system, rest @ ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if data.len() != 67 {
        return Err(err(BAD_DATA));
    }
    if !payer.is_signer() {
        return Err(err(NOT_ALLOWED));
    }
    if system.address() != &SYSTEM {
        return Err(err(BAD_ACCOUNT));
    }
    check(config, program_id, CONFIG, CONFIG_LEN)?;
    let mint: [u8; 32] = read(&config.try_borrow()?, 98);
    let id = &data[0..16];
    let bump = [data[16]];
    let vault_bump = [data[17]];
    let kind = data[18];
    let driver = &data[19..51];
    let driver_amount = u64::from_le_bytes(read(data, 51));
    let fee_amount = u64::from_le_bytes(read(data, 59));
    let total = driver_amount.checked_add(fee_amount).ok_or(err(BAD_AMOUNT))?;
    if total == 0 || kind > 1 {
        return Err(err(BAD_DATA));
    }
    if pda(&[b"escrow", id, &bump], program_id)? != *escrow.address() || driver == escrow.address().as_array() {
        return Err(err(BAD_ACCOUNT));
    }
    let rent = Rent::get()?;
    let mut lamports = rent.try_minimum_balance(ESCROW_LEN)?.checked_add(ALLOWANCE).ok_or(err(BAD_AMOUNT))?;
    if kind == 0 {
        lamports = lamports.checked_add(total).ok_or(err(BAD_AMOUNT))?;
    }
    let escrow_seeds = [Seed::from(b"escrow"), Seed::from(id), Seed::from(&bump)];
    CreateAccount { from: payer, to: escrow, lamports, space: ESCROW_LEN as u64, owner: program_id }
        .invoke_signed(&[Signer::from(&escrow_seeds[..])])?;
    if kind == 1 {
        let [mint_account, payer_token, vault, token, ..] = rest else {
            return Err(ProgramError::NotEnoughAccountKeys);
        };
        if token.address() != &TOKEN || mint_account.address().as_array() != &mint || driver == vault.address().as_array() {
            return Err(err(BAD_ACCOUNT));
        }
        if pda(&[b"vault", id, &vault_bump], program_id)? != *vault.address() {
            return Err(err(BAD_ACCOUNT));
        }
        let vault_seeds = [Seed::from(b"vault"), Seed::from(id), Seed::from(&vault_bump)];
        CreateAccount {
            from: payer,
            to: vault,
            lamports: rent.try_minimum_balance(TOKEN_ACCOUNT_LEN)?,
            space: TOKEN_ACCOUNT_LEN as u64,
            owner: &TOKEN,
        }
        .invoke_signed(&[Signer::from(&vault_seeds[..])])?;
        InitializeAccount3::new(vault, mint_account, escrow.address()).invoke()?;
        Transfer::new(payer_token, vault, payer, total).invoke()?;
    }
    let now = Clock::get()?.unix_timestamp;
    let mut d = escrow.try_borrow_mut()?;
    d[0] = ESCROW;
    d[1] = bump[0];
    d[2] = vault_bump[0];
    d[3] = kind;
    d[4..20].copy_from_slice(id);
    d[20..52].copy_from_slice(payer.address().as_array());
    d[52..84].copy_from_slice(driver);
    if kind == 1 {
        d[84..116].copy_from_slice(&mint);
    }
    d[116..124].copy_from_slice(&driver_amount.to_le_bytes());
    d[124..132].copy_from_slice(&fee_amount.to_le_bytes());
    d[132..140].copy_from_slice(&now.to_le_bytes());
    Ok(())
}

/// The server's key picks the outcome: 0 pay out, 1 50/50, 2 refund.
fn settle(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let [server, config, escrow, payer, driver, fee, rest @ ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if data.len() != 1 {
        return Err(err(BAD_DATA));
    }
    check(config, program_id, CONFIG, CONFIG_LEN)?;
    check(escrow, program_id, ESCROW, ESCROW_LEN)?;
    {
        let c = config.try_borrow()?;
        if !server.is_signer() || c[34..66] != server.address().as_array()[..] {
            return Err(err(NOT_ALLOWED));
        }
        if c[66..98] != fee.address().as_array()[..] {
            return Err(err(BAD_ACCOUNT));
        }
    }
    let e: [u8; ESCROW_LEN] = read(&escrow.try_borrow()?, 0);
    if payer.address().as_array()[..] != e[20..52] || driver.address().as_array()[..] != e[52..84] {
        return Err(err(BAD_ACCOUNT));
    }
    let driver_amount = u64::from_le_bytes(read(&e, 116));
    let fee_amount = u64::from_le_bytes(read(&e, 124));
    let total = driver_amount.checked_add(fee_amount).ok_or(err(BAD_AMOUNT))?;
    let (to_driver, to_fee) = match data[0] {
        0 => (driver_amount, fee_amount),
        1 => (total / 2, 0),
        2 => (0, 0),
        _ => return Err(err(BAD_DATA)),
    };
    let tokens = if e[3] == 1 {
        let [vault, payer_token, driver_token, fee_token, program, ..] = rest else {
            return Err(ProgramError::NotEnoughAccountKeys);
        };
        Some([*vault, *payer_token, *driver_token, *fee_token, *program])
    } else {
        None
    };
    release(program_id, &e, *escrow, *server, *payer, *driver, *fee, tokens, to_driver, to_fee)
}

/// After the timeout anyone may refund the rider in full, so money is never stuck if the server is gone.
fn expire(program_id: &Address, accounts: &mut [AccountView], _data: &[u8]) -> ProgramResult {
    let [sender, escrow, payer, rest @ ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if !sender.is_signer() {
        return Err(err(NOT_ALLOWED));
    }
    check(escrow, program_id, ESCROW, ESCROW_LEN)?;
    let e: [u8; ESCROW_LEN] = read(&escrow.try_borrow()?, 0);
    if payer.address().as_array()[..] != e[20..52] {
        return Err(err(BAD_ACCOUNT));
    }
    let created = i64::from_le_bytes(read(&e, 132));
    if Clock::get()?.unix_timestamp < created.saturating_add(TIMEOUT) {
        return Err(err(TOO_EARLY));
    }
    let tokens = if e[3] == 1 {
        let [vault, payer_token, program, ..] = rest else {
            return Err(ProgramError::NotEnoughAccountKeys);
        };
        // Nothing goes to the driver or the fee address, so the payer's token account stands in for theirs.
        Some([*vault, *payer_token, *payer_token, *payer_token, *program])
    } else {
        None
    };
    release(program_id, &e, *escrow, *sender, *payer, *payer, *payer, tokens, 0, 0)
}

/// Pays the driver and the fee address their parts, everything else to the payer, the sender its allowance, and
/// closes the escrow (and its vault).
#[allow(clippy::too_many_arguments)]
fn release(
    program_id: &Address,
    e: &[u8; ESCROW_LEN],
    escrow: AccountView,
    sender: AccountView,
    payer: AccountView,
    driver: AccountView,
    fee: AccountView,
    tokens: Option<[AccountView; 5]>,
    to_driver: u64,
    to_fee: u64,
) -> ProgramResult {
    let id = &e[4..20];
    let bump = [e[1]];
    match tokens {
        None => {
            transfer_lamports(escrow, driver, to_driver)?;
            transfer_lamports(escrow, fee, to_fee)?;
        }
        Some([vault, payer_token, driver_token, fee_token, program]) => {
            if program.address() != &TOKEN {
                return Err(err(BAD_ACCOUNT));
            }
            let vault_bump = [e[2]];
            if pda(&[b"vault", id, &vault_bump], program_id)? != *vault.address() {
                return Err(err(BAD_ACCOUNT));
            }
            let mint = &e[84..116];
            // Everything in the vault, also anything someone sent it on top, so it can always be closed.
            let held = token_amount(&vault, mint, escrow.address().as_array())?;
            let to_payer = held
                .checked_sub(to_driver)
                .and_then(|left| left.checked_sub(to_fee))
                .ok_or(err(BAD_AMOUNT))?;
            // A rider who closed or gave away their token account could otherwise block a payout (or a 50/50) until the
            // timeout, and get it all back. They only hold up their own part.
            let payer_ready = to_payer == 0 || token_amount(&payer_token, mint, &e[20..52]).is_ok();
            if !payer_ready && to_driver == 0 && to_fee == 0 {
                return Err(err(BAD_ACCOUNT));
            }
            let seeds = [Seed::from(b"escrow"), Seed::from(id), Seed::from(&bump)];
            let signers = [Signer::from(&seeds[..])];
            send_tokens(&vault, &driver_token, &escrow, to_driver, mint, &e[52..84], &signers)?;
            send_tokens(&vault, &fee_token, &escrow, to_fee, mint, fee.address().as_array(), &signers)?;
            if !payer_ready {
                let mut left = escrow;
                left.try_borrow_mut()?[116..132].fill(0);
                return transfer_lamports(escrow, sender, ALLOWANCE);
            }
            send_tokens(&vault, &payer_token, &escrow, to_payer, mint, &e[20..52], &signers)?;
            CloseAccount::new(&vault, &payer, &escrow).invoke_signed(&signers)?;
        }
    }
    transfer_lamports(escrow, sender, ALLOWANCE)?;
    transfer_lamports(escrow, payer, escrow.lamports())?;
    let mut escrow = escrow;
    escrow.close()
}

fn send_tokens(
    vault: &AccountView,
    to: &AccountView,
    escrow: &AccountView,
    amount: u64,
    mint: &[u8],
    owner: &[u8],
    signers: &[Signer],
) -> ProgramResult {
    if amount == 0 {
        return Ok(());
    }
    token_amount(to, mint, owner)?;
    Transfer::new(vault, to, escrow, amount).invoke_signed(signers)
}

/// The balance of a token account, after checking it's an initialised token account of this mint and owner.
fn token_amount(account: &AccountView, mint: &[u8], owner: &[u8]) -> Result<u64, ProgramError> {
    if !account.owned_by(&TOKEN) || account.data_len() != TOKEN_ACCOUNT_LEN {
        return Err(err(BAD_ACCOUNT));
    }
    let d = account.try_borrow()?;
    if d[0..32] != *mint || d[32..64] != *owner || d[108] != 1 {
        return Err(err(BAD_ACCOUNT));
    }
    Ok(u64::from_le_bytes(read(&d, 64)))
}

fn transfer_lamports(mut from: AccountView, mut to: AccountView, amount: u64) -> ProgramResult {
    if amount == 0 {
        return Ok(());
    }
    from.set_lamports(from.lamports().checked_sub(amount).ok_or(err(BAD_AMOUNT))?);
    to.set_lamports(to.lamports().checked_add(amount).ok_or(err(BAD_AMOUNT))?);
    Ok(())
}

fn check(account: &AccountView, program_id: &Address, kind: u8, len: usize) -> ProgramResult {
    if !account.owned_by(program_id) || account.data_len() != len || account.try_borrow()?[0] != kind {
        return Err(err(BAD_ACCOUNT));
    }
    Ok(())
}

fn pda(seeds: &[&[u8]], program_id: &Address) -> Result<Address, ProgramError> {
    Address::create_program_address(seeds, program_id).map_err(|_| err(BAD_ACCOUNT))
}

fn read<const N: usize>(d: &[u8], at: usize) -> [u8; N] {
    let mut out = [0; N];
    out.copy_from_slice(&d[at..at + N]);
    out
}
