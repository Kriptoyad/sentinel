// SENTINEL — Perpetual Probability Market Protocol (v2)
// Anchor program (devnet). NOT audited. Hackathon MVP scope.
//
// v2 changes vs v1:
// - Resolution methodology fixed: outcome = single snapshot AT resolution_deadline
//   (not a barrier/touch condition). Enforced by convention in off-chain metadata;
//   the deadline field itself is unchanged, this is a documentation/UX contract.
// - Added a dispute window between `resolve_market` (or `resolve_expired`) and
//   when claims become payable, during which a separate `dispute_authority`
//   can correct the outcome via `override_resolution`.
// - Added `resolve_expired`: permissionless fallback so an unresolved market
//   past its deadline defaults to `false` (no incident / no) instead of
//   staying stuck forever.
// - `fund_pool` now rejects deposits once a market is resolved, so the pool
//   balance used for payout is frozen at the same moment exposures are frozen.
// - `claim_payout` now requires the dispute window to have elapsed.

use anchor_lang::prelude::*;
use anchor_spl::{associated_token::AssociatedToken, token::{self, Mint, Token, TokenAccount, Transfer}};

declare_id!("3PA87yNfZD3DptejAafT2ovehCkh3xo8DhUVQoyWTw2P");

// Explicit local-only feature to exercise final payouts without waiting an hour.
// The normal build and Devnet deployment retain the full 3600-second window.
#[cfg(feature = "local-short-dispute")]
pub const DISPUTE_WINDOW_SECS: i64 = 3;
#[cfg(not(feature = "local-short-dispute"))]
pub const DISPUTE_WINDOW_SECS: i64 = 3600;
pub const ORACLE_GRACE_SECS: i64 = 300; // allow the oracle five minutes after the deadline

// ---------------------------------------------------------------------------
// PROGRAM
// ---------------------------------------------------------------------------

#[program]
pub mod sentinel {
    use super::*;

    pub fn initialize_market(
        ctx: Context<InitializeMarket>,
        market_id: u64,
        market_type: MarketType,
        question_hash: [u8; 32],
        metadata_uri: String,
        initial_probability_bps: u16,
        oracle_authority: Pubkey,
        dispute_authority: Pubkey,
        resolution_deadline: i64,
    ) -> Result<()> {
        require!(initial_probability_bps <= 10_000, SentinelError::InvalidProbability);
        require!(metadata_uri.len() <= 200, SentinelError::UriTooLong);
        require!(resolution_deadline > Clock::get()?.unix_timestamp, SentinelError::MarketExpired);

        let market = &mut ctx.accounts.market;
        market.market_id = market_id;
        market.market_type = market_type;
        market.question_hash = question_hash;
        market.metadata_uri = metadata_uri;
        market.creator = ctx.accounts.creator.key();
        market.collateral_mint = ctx.accounts.collateral_mint.key();
        market.oracle_authority = oracle_authority;
        market.dispute_authority = dispute_authority;
        market.probability_bps = initial_probability_bps;
        market.cumulative_funding = 0;
        market.last_update_ts = Clock::get()?.unix_timestamp;
        market.total_yes_exposure = 0;
        market.total_no_exposure = 0;
        market.resolved = false;
        market.resolution_outcome = None;
        market.resolution_ts = None;
        market.finalized_at = None;
        market.resolution_deadline = resolution_deadline;
        market.bump = ctx.bumps.market;

        emit!(MarketInitialized {
            market: market.key(),
            market_id,
            market_type,
            initial_probability_bps,
            oracle_authority,
            dispute_authority,
            resolution_deadline,
        });
        Ok(())
    }

    pub fn open_position(ctx: Context<OpenPosition>, side: Side, amount: u64) -> Result<()> {
        let market = &mut ctx.accounts.market;
        require!(!market.resolved, SentinelError::MarketResolved);
        require!(Clock::get()?.unix_timestamp < market.resolution_deadline, SentinelError::MarketExpired);
        require!(amount > 0, SentinelError::InvalidAmount);

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.user_token_account.to_account_info(),
                    to: ctx.accounts.market_vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
        )?;

        let position = &mut ctx.accounts.position;
        position.market = market.key();
        position.owner = ctx.accounts.user.key();
        position.side = side;
        position.size = amount;
        position.entry_probability_bps = market.probability_bps;
        position.entry_funding_index = market.cumulative_funding;
        position.opened_at = Clock::get()?.unix_timestamp;
        position.closed = false;
        position.bump = ctx.bumps.position;

        match side {
            Side::Yes => {
                market.total_yes_exposure = market
                    .total_yes_exposure
                    .checked_add(amount)
                    .ok_or(SentinelError::MathOverflow)?
            }
            Side::No => {
                market.total_no_exposure = market
                    .total_no_exposure
                    .checked_add(amount)
                    .ok_or(SentinelError::MathOverflow)?
            }
        }

        emit!(PositionOpened {
            market: market.key(),
            position: position.key(),
            owner: position.owner,
            side,
            amount,
            entry_probability_bps: position.entry_probability_bps,
        });
        Ok(())
    }

    pub fn close_position(ctx: Context<ClosePosition>) -> Result<()> {
        let market_info = ctx.accounts.market.to_account_info();
        let market = &mut ctx.accounts.market;
        let position = &mut ctx.accounts.position;
        require!(!position.closed, SentinelError::PositionAlreadyClosed);
        require!(!market.resolved, SentinelError::MarketResolved);
        require!(Clock::get()?.unix_timestamp < market.resolution_deadline, SentinelError::MarketExpired);

        // Hackathon MVP: closing before the deadline returns the stake. The
        // cumulative funding index is informational until settlement logic is built.
        let payout = position.size;

        // A funded risk pool must always retain at least one position on each
        // side so its bonus can be awarded regardless of the final outcome.
        if market.market_type == MarketType::Risk && ctx.accounts.pool.total_deposited > 0 {
            let exposure = match position.side {
                Side::Yes => market.total_yes_exposure,
                Side::No => market.total_no_exposure,
            };
            require!(exposure > position.size, SentinelError::LastFundedPosition);
        }

        let market_id_bytes = market.market_id.to_le_bytes();
        let seeds: &[&[u8]] = &[b"market", market_id_bytes.as_ref(), &[market.bump]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.market_vault.to_account_info(),
                    to: ctx.accounts.user_token_account.to_account_info(),
                    authority: market_info,
                },
                &[seeds],
            ),
            payout,
        )?;

        position.closed = true;
        match position.side {
            Side::Yes => market.total_yes_exposure = market.total_yes_exposure
                .checked_sub(position.size).ok_or(SentinelError::MathOverflow)?,
            Side::No => market.total_no_exposure = market.total_no_exposure
                .checked_sub(position.size).ok_or(SentinelError::MathOverflow)?,
        }

        emit!(PositionClosed {
            market: market.key(),
            position: position.key(),
            owner: position.owner,
            payout,
        });
        Ok(())
    }

    pub fn update_probability(
        ctx: Context<UpdateProbability>,
        new_probability_bps: u16,
        source_ts: i64,
    ) -> Result<()> {
        require!(new_probability_bps <= 10_000, SentinelError::InvalidProbability);
        let market = &mut ctx.accounts.market;
        require!(
            ctx.accounts.oracle_authority.key() == market.oracle_authority,
            SentinelError::Unauthorized
        );
        require!(!market.resolved, SentinelError::MarketResolved);
        let now = Clock::get()?.unix_timestamp;
        require!(now < market.resolution_deadline, SentinelError::MarketExpired);
        require!(source_ts <= now && source_ts >= now - 300, SentinelError::StaleOracle);
        let dt = now - market.last_update_ts;
        let funding_delta = (market.probability_bps as i64 - 5_000) * dt / 86_400;
        market.cumulative_funding = market
            .cumulative_funding
            .checked_add(funding_delta)
            .ok_or(SentinelError::MathOverflow)?;

        market.probability_bps = new_probability_bps;
        market.last_update_ts = now;

        emit!(ProbabilityUpdated {
            market: market.key(),
            new_probability_bps,
            cumulative_funding: market.cumulative_funding,
            source_ts,
        });
        Ok(())
    }

    pub fn log_agent_decision(
        ctx: Context<LogAgentDecision>,
        agent_id: u8,
        side: Side,
        confidence_bps: u16,
        reasoning_hash: [u8; 32],
    ) -> Result<()> {
        require!(confidence_bps <= 10_000, SentinelError::InvalidProbability);
        let market = &ctx.accounts.market;
        require!(ctx.accounts.agent_authority.key() == market.oracle_authority, SentinelError::Unauthorized);
        require!(!market.resolved && Clock::get()?.unix_timestamp < market.resolution_deadline, SentinelError::MarketExpired);

        emit!(AgentDecisionLogged {
            market: market.key(),
            agent_id,
            side,
            confidence_bps,
            reasoning_hash,
            ts: Clock::get()?.unix_timestamp,
            authority: ctx.accounts.agent_authority.key(),
        });
        Ok(())
    }

    /// Oracle-authority-only. Proposes the final resolution. Starts the dispute window.
    pub fn resolve_market(ctx: Context<ResolveMarket>, outcome: bool) -> Result<()> {
        let market = &mut ctx.accounts.market;
        require!(
            ctx.accounts.oracle_authority.key() == market.oracle_authority,
            SentinelError::Unauthorized
        );
        require!(!market.resolved, SentinelError::MarketResolved);

        let now = Clock::get()?.unix_timestamp;
        require!(now >= market.resolution_deadline, SentinelError::NotYetExpired);
        market.resolved = true;
        market.resolution_outcome = Some(outcome);
        market.resolution_ts = Some(now);
        market.finalized_at = Some(now + DISPUTE_WINDOW_SECS);

        emit!(MarketResolved {
            market: market.key(),
            outcome,
            resolution_ts: now,
            auto_resolved: false,
        });
        Ok(())
    }

    /// Permissionless fallback. If nobody resolved by the deadline, default to `false`
    /// (no incident / no) so the market never gets stuck. Still goes through the
    /// same dispute window before claims open.
    pub fn resolve_expired(ctx: Context<ResolveExpired>) -> Result<()> {
        let market = &mut ctx.accounts.market;
        require!(!market.resolved, SentinelError::MarketResolved);
        let now = Clock::get()?.unix_timestamp;
        require!(now >= market.resolution_deadline + ORACLE_GRACE_SECS, SentinelError::NotYetExpired);

        market.resolved = true;
        market.resolution_outcome = Some(false);
        market.resolution_ts = Some(now);
        market.finalized_at = Some(now + DISPUTE_WINDOW_SECS);

        emit!(MarketResolved {
            market: market.key(),
            outcome: false,
            resolution_ts: now,
            auto_resolved: true,
        });
        Ok(())
    }

    /// Dispute-authority-only. Corrects a resolution before the dispute window closes.
    pub fn override_resolution(ctx: Context<OverrideResolution>, new_outcome: bool) -> Result<()> {
        let market = &mut ctx.accounts.market;
        require!(
            ctx.accounts.dispute_authority.key() == market.dispute_authority,
            SentinelError::Unauthorized
        );
        require!(market.resolved, SentinelError::MarketNotResolved);
        let now = Clock::get()?.unix_timestamp;
        let finalized_at = market.finalized_at.ok_or(SentinelError::MarketNotResolved)?;
        require!(now < finalized_at, SentinelError::DisputeWindowClosed);

        market.resolution_outcome = Some(new_outcome);

        emit!(ResolutionOverridden {
            market: market.key(),
            new_outcome,
            ts: now,
        });
        Ok(())
    }

    // -------------------------------------------------------------------
    // POOL — a zero-balance pool account is required for all markets to keep
    // the claim interface uniform. Only Risk markets can receive bonus funds.
    // -------------------------------------------------------------------

    pub fn init_pool(ctx: Context<InitPool>, disclaimer_hash: [u8; 32]) -> Result<()> {
        require!(!ctx.accounts.market.resolved && Clock::get()?.unix_timestamp < ctx.accounts.market.resolution_deadline, SentinelError::MarketExpired);
        let pool = &mut ctx.accounts.pool;
        pool.market = ctx.accounts.market.key();
        pool.authority = ctx.accounts.authority.key();
        pool.total_deposited = 0;
        pool.total_claimed = 0;
        pool.disclaimer_hash = disclaimer_hash;
        pool.bump = ctx.bumps.pool;
        Ok(())
    }

    /// Blocked once the market is resolved, so the payable amount is frozen
    /// at the same moment exposures are frozen.
    pub fn fund_pool(ctx: Context<FundPool>, amount: u64) -> Result<()> {
        require!(ctx.accounts.market.market_type == MarketType::Risk, SentinelError::WrongMarketType);
        require!(!ctx.accounts.market.resolved, SentinelError::MarketResolved);
        require!(Clock::get()?.unix_timestamp < ctx.accounts.market.resolution_deadline, SentinelError::MarketExpired);
        require!(amount > 0, SentinelError::InvalidAmount);
        require!(ctx.accounts.market.total_yes_exposure > 0 && ctx.accounts.market.total_no_exposure > 0, SentinelError::MissingCounterparty);

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.funder_token_account.to_account_info(),
                    to: ctx.accounts.pool_vault.to_account_info(),
                    authority: ctx.accounts.funder.to_account_info(),
                },
            ),
            amount,
        )?;
        let pool = &mut ctx.accounts.pool;
        pool.total_deposited = pool
            .total_deposited
            .checked_add(amount)
            .ok_or(SentinelError::MathOverflow)?;

        emit!(PoolFunded {
            pool: pool.key(),
            market: pool.market,
            amount,
            new_total: pool.total_deposited,
        });
        Ok(())
    }

    /// Requires the dispute window to have elapsed, so the outcome used is final.
    pub fn claim_payout(ctx: Context<ClaimPayout>) -> Result<()> {
        let market = &ctx.accounts.market;
        let pool = &mut ctx.accounts.pool;
        let position = &mut ctx.accounts.position;

        require!(market.resolved, SentinelError::MarketNotResolved);
        let finalized_at = market.finalized_at.ok_or(SentinelError::MarketNotResolved)?;
        require!(Clock::get()?.unix_timestamp >= finalized_at, SentinelError::DisputeWindowActive);
        require!(!position.closed, SentinelError::PositionAlreadyClosed);

        let outcome = market.resolution_outcome.ok_or(SentinelError::MarketNotResolved)?;
        let winning_exposure = if outcome {
            market.total_yes_exposure
        } else {
            market.total_no_exposure
        };
        let no_winners = winning_exposure == 0;
        let won = (outcome && position.side == Side::Yes) || (!outcome && position.side == Side::No);
        require!(won || no_winners, SentinelError::NotEntitled);

        // No-winner price markets refund principal. A funded Risk pool cannot
        // enter this state because funding requires positions on both sides,
        // and the last position on either side cannot close before resolution.
        let bonus = if no_winners { 0 } else {
            (pool.total_deposited as u128)
                .checked_mul(position.size as u128)
                .ok_or(SentinelError::MathOverflow)?
                .checked_div(winning_exposure as u128)
                .ok_or(SentinelError::MathOverflow)? as u64
        };

        // The market vault contains the deposits of every position still open
        // at resolution. Winning positions split this pot pro-rata. Closed
        // positions were refunded earlier and removed from the denominator.
        let stake_total = market.total_yes_exposure
            .checked_add(market.total_no_exposure)
            .ok_or(SentinelError::MathOverflow)?;
        let stake_payout = if no_winners { position.size } else {
            (stake_total as u128)
                .checked_mul(position.size as u128)
                .ok_or(SentinelError::MathOverflow)?
                .checked_div(winning_exposure as u128)
                .ok_or(SentinelError::MathOverflow)? as u64
        };
        let total_payout = stake_payout.checked_add(bonus).ok_or(SentinelError::MathOverflow)?;

        let market_key = market.key();
        let seeds: &[&[u8]] = &[b"pool", market_key.as_ref(), &[pool.bump]];

        if bonus > 0 {
          token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.pool_vault.to_account_info(),
                    to: ctx.accounts.user_token_account.to_account_info(),
                    authority: pool.to_account_info(),
                },
                &[seeds],
            ),
            bonus,
          )?;
        }

        let market_id_bytes = market.market_id.to_le_bytes();
        let market_seeds: &[&[u8]] = &[b"market", market_id_bytes.as_ref(), &[market.bump]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.market_vault.to_account_info(),
                    to: ctx.accounts.user_token_account.to_account_info(),
                    authority: ctx.accounts.market.to_account_info(),
                },
                &[market_seeds],
            ),
            stake_payout,
        )?;

        pool.total_claimed = pool
            .total_claimed
            .checked_add(bonus)
            .ok_or(SentinelError::MathOverflow)?;
        position.closed = true;

        emit!(ClaimPaid {
            pool: pool.key(),
            market: market.key(),
            owner: position.owner,
            amount: total_payout,
        });
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// STATE
// ---------------------------------------------------------------------------

#[account]
pub struct Market {
    pub market_id: u64,
    pub market_type: MarketType,
    pub question_hash: [u8; 32],
    pub metadata_uri: String,
    pub creator: Pubkey,
    pub collateral_mint: Pubkey,
    pub oracle_authority: Pubkey,
    pub dispute_authority: Pubkey,
    pub probability_bps: u16,
    pub cumulative_funding: i64,
    pub last_update_ts: i64,
    pub total_yes_exposure: u64,
    pub total_no_exposure: u64,
    pub resolved: bool,
    pub resolution_outcome: Option<bool>,
    pub resolution_ts: Option<i64>,
    pub finalized_at: Option<i64>,
    pub resolution_deadline: i64,
    pub bump: u8,
}

#[account]
pub struct Position {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub side: Side,
    pub size: u64,
    pub entry_probability_bps: u16,
    pub entry_funding_index: i64,
    pub opened_at: i64,
    pub closed: bool,
    pub bump: u8,
}

/// Voluntary payout pool for Risk-type markets. NOT an insurance contract.
#[account]
pub struct Pool {
    pub market: Pubkey,
    pub authority: Pubkey,
    pub total_deposited: u64,
    pub total_claimed: u64,
    pub disclaimer_hash: [u8; 32],
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum MarketType {
    Price,
    Risk,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    Yes,
    No,
}

// ---------------------------------------------------------------------------
// EVENTS
// ---------------------------------------------------------------------------

#[event]
pub struct MarketInitialized {
    pub market: Pubkey,
    pub market_id: u64,
    pub market_type: MarketType,
    pub initial_probability_bps: u16,
    pub oracle_authority: Pubkey,
    pub dispute_authority: Pubkey,
    pub resolution_deadline: i64,
}

#[event]
pub struct PositionOpened {
    pub market: Pubkey,
    pub position: Pubkey,
    pub owner: Pubkey,
    pub side: Side,
    pub amount: u64,
    pub entry_probability_bps: u16,
}

#[event]
pub struct PositionClosed {
    pub market: Pubkey,
    pub position: Pubkey,
    pub owner: Pubkey,
    pub payout: u64,
}

#[event]
pub struct ProbabilityUpdated {
    pub market: Pubkey,
    pub new_probability_bps: u16,
    pub cumulative_funding: i64,
    pub source_ts: i64,
}

#[event]
pub struct AgentDecisionLogged {
    pub market: Pubkey,
    pub agent_id: u8,
    pub side: Side,
    pub confidence_bps: u16,
    pub reasoning_hash: [u8; 32],
    pub ts: i64,
    pub authority: Pubkey,
}

#[event]
pub struct MarketResolved {
    pub market: Pubkey,
    pub outcome: bool,
    pub resolution_ts: i64,
    pub auto_resolved: bool,
}

#[event]
pub struct ResolutionOverridden {
    pub market: Pubkey,
    pub new_outcome: bool,
    pub ts: i64,
}

#[event]
pub struct PoolFunded {
    pub pool: Pubkey,
    pub market: Pubkey,
    pub amount: u64,
    pub new_total: u64,
}

#[event]
pub struct ClaimPaid {
    pub pool: Pubkey,
    pub market: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
}

// ---------------------------------------------------------------------------
// CONTEXTS
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct InitializeMarket<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(
        init,
        payer = creator,
        space = 8 + 512,
        seeds = [b"market", market_id.to_le_bytes().as_ref()],
        bump
    )]
    pub market: Account<'info, Market>,
    pub collateral_mint: Account<'info, Mint>,
    #[account(init, payer = creator, associated_token::mint = collateral_mint, associated_token::authority = market)]
    pub market_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OpenPosition<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut)]
    pub market: Account<'info, Market>,
    #[account(has_one = market)]
    pub pool: Account<'info, Pool>,
    #[account(
        init,
        payer = user,
        space = 8 + 128,
        seeds = [b"position", market.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub position: Account<'info, Position>,
    #[account(mut, token::mint = market.collateral_mint, token::authority = user)]
    pub user_token_account: Account<'info, TokenAccount>,
    #[account(mut, associated_token::mint = collateral_mint, associated_token::authority = market)]
    pub market_vault: Account<'info, TokenAccount>,
    #[account(address = market.collateral_mint)]
    pub collateral_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClosePosition<'info> {
    pub user: Signer<'info>,
    #[account(mut)]
    pub market: Account<'info, Market>,
    #[account(has_one = market)]
    pub pool: Account<'info, Pool>,
    #[account(mut, has_one = market, constraint = position.owner == user.key() @ SentinelError::Unauthorized)]
    pub position: Account<'info, Position>,
    #[account(mut, token::mint = market.collateral_mint, token::authority = user)]
    pub user_token_account: Account<'info, TokenAccount>,
    #[account(mut, associated_token::mint = collateral_mint, associated_token::authority = market)]
    pub market_vault: Account<'info, TokenAccount>,
    #[account(address = market.collateral_mint)]
    pub collateral_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct UpdateProbability<'info> {
    pub oracle_authority: Signer<'info>,
    #[account(mut)]
    pub market: Account<'info, Market>,
}

#[derive(Accounts)]
pub struct LogAgentDecision<'info> {
    pub agent_authority: Signer<'info>,
    pub market: Account<'info, Market>,
}

#[derive(Accounts)]
pub struct ResolveMarket<'info> {
    pub oracle_authority: Signer<'info>,
    #[account(mut)]
    pub market: Account<'info, Market>,
}

#[derive(Accounts)]
pub struct ResolveExpired<'info> {
    pub caller: Signer<'info>,
    #[account(mut)]
    pub market: Account<'info, Market>,
}

#[derive(Accounts)]
pub struct OverrideResolution<'info> {
    pub dispute_authority: Signer<'info>,
    #[account(mut)]
    pub market: Account<'info, Market>,
}

#[derive(Accounts)]
pub struct InitPool<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(constraint = market.creator == authority.key() @ SentinelError::Unauthorized)]
    pub market: Account<'info, Market>,
    #[account(
        init,
        payer = authority,
        space = 8 + 128,
        seeds = [b"pool", market.key().as_ref()],
        bump
    )]
    pub pool: Account<'info, Pool>,
    #[account(address = market.collateral_mint)]
    pub collateral_mint: Account<'info, Mint>,
    #[account(init, payer = authority, associated_token::mint = collateral_mint, associated_token::authority = pool)]
    pub pool_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FundPool<'info> {
    #[account(mut)]
    pub funder: Signer<'info>,
    pub market: Account<'info, Market>,
    #[account(mut, has_one = market)]
    pub pool: Account<'info, Pool>,
    #[account(mut, token::mint = market.collateral_mint, token::authority = funder)]
    pub funder_token_account: Account<'info, TokenAccount>,
    #[account(mut, associated_token::mint = collateral_mint, associated_token::authority = pool)]
    pub pool_vault: Account<'info, TokenAccount>,
    #[account(address = market.collateral_mint)]
    pub collateral_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ClaimPayout<'info> {
    pub user: Signer<'info>,
    pub market: Account<'info, Market>,
    #[account(mut, has_one = market)]
    pub pool: Account<'info, Pool>,
    #[account(mut, has_one = market, constraint = position.owner == user.key() @ SentinelError::Unauthorized)]
    pub position: Account<'info, Position>,
    #[account(mut, token::mint = market.collateral_mint, token::authority = user)]
    pub user_token_account: Account<'info, TokenAccount>,
    #[account(mut, associated_token::mint = collateral_mint, associated_token::authority = pool)]
    pub pool_vault: Account<'info, TokenAccount>,
    #[account(mut, associated_token::mint = collateral_mint, associated_token::authority = market)]
    pub market_vault: Account<'info, TokenAccount>,
    #[account(address = market.collateral_mint)]
    pub collateral_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}

// ---------------------------------------------------------------------------
// ERRORS
// ---------------------------------------------------------------------------

#[error_code]
pub enum SentinelError {
    #[msg("Probability must be between 0 and 10000 bps")]
    InvalidProbability,
    #[msg("Metadata URI too long")]
    UriTooLong,
    #[msg("Amount must be greater than zero")]
    InvalidAmount,
    #[msg("Market is already resolved")]
    MarketResolved,
    #[msg("Market is not yet resolved")]
    MarketNotResolved,
    #[msg("Resolution deadline has not passed yet")]
    NotYetExpired,
    #[msg("Dispute window has already closed")]
    DisputeWindowClosed,
    #[msg("Dispute window is still active, claims not open yet")]
    DisputeWindowActive,
    #[msg("Position already closed")]
    PositionAlreadyClosed,
    #[msg("Unauthorized signer")]
    Unauthorized,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Position not entitled to a claim")]
    NotEntitled,
    #[msg("Market deadline has passed")]
    MarketExpired,
    #[msg("Oracle update is stale or in the future")]
    StaleOracle,
    #[msg("Only risk markets can receive voluntary pool funds")]
    WrongMarketType,
    #[msg("Both YES and NO positions are required before funding a risk pool")]
    MissingCounterparty,
    #[msg("Cannot close the last position on a side while the risk pool is funded")]
    LastFundedPosition,
}
