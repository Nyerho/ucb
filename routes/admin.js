'use strict';
const express = require('express');
const crypto = require('node:crypto');
const { createFirestoreRepository } = require('../services/firestore-rest');
const { readMinorUnits, fromMinorUnits } = require('../services/money');
const { requireAdmin, isAdminUser } = require('../middleware/auth');
const requireSessionEncryptionReady = require('../middleware/session-encryption-ready');
const { createAdminWorkflows } = require('../services/admin-workflows');
const { signUpWithPassword, sendPasswordResetEmail, deleteFirebaseUser } = require('../services/firebase-auth-rest');
const { downloadObject } = require('../services/firebase-storage');
const router = express.Router();
const repo = createFirestoreRepository();
const adminWorkflows = createAdminWorkflows(repo);
router.use(require('../middleware/production-financial-gate'));
router.use(requireAdmin);
const id = value => String(value);
const display = row => {
  if (!row) return row;
  const out = { ...row };
  for (const key of Object.keys(out)) if (key.endsWith('_minor')) out[key.slice(0, -6)] = fromMinorUnits(readMinorUnits(out, key, key.slice(0, -6)));
  return out;
};
async function rows(collection, filters = [], orderBy = 'created_at', limit = 500, direction = 'DESCENDING') {
  return (await repo.list(collection, filters, { orderBy: { field: orderBy, direction }, limit })).map(display);
}
async function getUser(uid) { return display(await repo.get('users', id(uid))); }
async function withUser(row) {
  const u = await getUser(row.user_id);
  return { ...display(row), first_name: u?.first_name || '', last_name: u?.last_name || '', email: u?.email || '', phone: u?.phone || '', user_name: `${u?.first_name || ''} ${u?.last_name || ''}`.trim() };
}
function safeAdminCard(row) {
  const safe = { ...row };
  const digits = String(safe.card_number || '');
  safe.card_last4 = digits.slice(-4);
  safe.card_number = safe.card_last4;
  delete safe.cvv;
  delete safe.pin_hash;
  return safe;
}
function safeAdminKyc(row) {
  const safe = { ...row };
  safe.has_document_front = Boolean(safe.document_front);
  safe.has_document_back = Boolean(safe.document_back);
  safe.has_document_selfie = Boolean(safe.document_selfie);
  delete safe.document_number;
  delete safe.document_front;
  delete safe.document_back;
  delete safe.document_selfie;
  return safe;
}
function newOperationId() { return crypto.randomBytes(18).toString('base64url'); }
async function accountsWithUsers() {
  return Promise.all((await rows('accounts', [], 'created_at', 500)).map(async a => {
    const u = await getUser(a.user_id);
    return { ...a, first_name: u?.first_name || '', last_name: u?.last_name || '', email: u?.email || '', is_frozen: u?.is_frozen || false, user_name: `${u?.first_name || ''} ${u?.last_name || ''}`.trim() };
  }));
}
function unavailable(_req, res) {
  return res.status(503).render('error', { title: 'Temporarily unavailable', message: 'This administrative operation is unavailable until its Firestore transaction, integer-minor-unit, immutable-ledger, and audit handling are migrated.' });
}
function registerAdminPost(routePath, action, successMessage, redirectPath) {
  router.post(routePath, requireSessionEncryptionReady, async (req, res) => {
    let result;
    try {
      result = await action(req);
      if (result && result.changed === false) req.session.success = 'No changes were needed.';
      else if (result && result.passwordResetSent === false) req.session.success = 'Customer profile created, but Firebase could not confirm delivery of the password-reset email. Use the audited reset action to try again.';
      else req.session.success = typeof successMessage === 'function' ? successMessage(result, req) : successMessage;
    } catch (error) {
      const status = Number(error && error.status) || 500;
      if (status >= 500) console.error('Safe admin operation failed:', routePath, error && error.message ? error.message : 'unknown error');
      req.session.error = status < 500 ? error.message : 'The change could not be confirmed. Review the current record and audit log before retrying.';
    }
    return res.redirect(typeof redirectPath === 'function' ? redirectPath(req, result) : redirectPath);
  });
}
router.get('/dashboard', async (req, res, next) => {
  try {
    const [users, accounts, transactions, cards, loans, kyc, bills] = await Promise.all([
      rows('users', [], 'created_at', 1000), rows('accounts', [], 'created_at', 1000), rows('transactions', [], 'created_at', 1000),
      rows('cards', [], 'created_at', 1000), rows('loans', [], 'created_at', 1000), rows('kyc', [{ field: 'status', value: 'pending' }], 'submitted_at', 1000), rows('bill_payments', [{ field: 'status', value: 'pending' }], 'created_at', 1000)
    ]);
    const customers = users.filter(u => !isAdminUser(u) || accounts.some(a => a.user_id === u.id && a.account_type !== 'Admin Account'));
    const recentTransactions = await Promise.all(transactions.slice(0, 10).map(async t => { const [u,a] = await Promise.all([getUser(t.user_id),repo.get('accounts',id(t.account_id))]); return { ...display(t), first_name:u?.first_name||'',last_name:u?.last_name||'',account_name:a?.account_name||'' }; }));
    const recentUsers = customers.slice(0,5).map(u => ({...u,account_count:accounts.filter(a=>a.user_id===u.id).length}));
    const total = (rs,k) => rs.reduce((s,r)=>s+readMinorUnits(r,`${k}_minor`,k),0)/100;
    const now = new Date();
    const date = now.toISOString().slice(0,10);
    const todays = transactions.filter(t=>String(t.created_at||'').slice(0,10)===date);
    const weekAgo = now.getTime() - 7 * 24 * 60 * 60 * 1000;
    const newThisWeek = customers.filter(user => {
      const createdAt = Date.parse(user.created_at || '');
      return Number.isFinite(createdAt) && createdAt >= weekAgo && createdAt <= now.getTime();
    }).length;
    const audAccounts = accounts.filter(account => String(account.currency || 'AUD').toUpperCase() === 'AUD');
    const audTodays = todays.filter(transaction => String(transaction.currency || 'AUD').toUpperCase() === 'AUD');
    const todayVolume = audTodays.reduce((sum, transaction) => sum + Math.abs(readMinorUnits(transaction, 'amount_minor', 'amount')), 0) / 100;
    const stats = { totalUsers:customers.length,totalCustomers:customers.length,totalAccounts:accounts.length,activeAccounts:accounts.filter(a=>String(a.status||'active').toLowerCase()==='active').length,totalCards:cards.length,totalLoans:loans.length,pendingKYC:kyc.length,pendingTransfers:transactions.filter(t=>t.status==='pending').length,pendingCards:cards.filter(c=>c.status==='pending').length,pendingLoans:loans.filter(l=>l.status==='pending').length,pendingBills:bills.length,frozenAccounts:users.filter(u=>u.is_frozen).length,totalBalance:total(audAccounts,'balance'),loansDisbursed:total(loans.filter(l=>l.status==='disbursed'),'loan_amount'),totalLoansOutstanding:total(loans.filter(l=>l.status==='disbursed'),'remaining_balance'),recentUsers,recentTransactions,todayTransactions:todays.length,todayVolume,newThisWeek,activeCards:cards.filter(c=>c.status==='active').length,activeLoans:loans.filter(l=>l.status==='disbursed').length,unverifiedCustomers:customers.filter(u=>!u.is_verified).length };
    const admin=req.user;
    res.render('admin/dashboard',{title:'Admin Dashboard - United Credit Bank',page:'admin-dashboard',admin,user:admin,stats,pendingCount:stats.pendingKYC+stats.pendingTransfers+stats.pendingCards+stats.pendingLoans+stats.pendingBills,recentUsers,recentTransactions});
  } catch(e){next(e);}
});
router.get('/users',async(req,res,next)=>{try{
  const {search,status,verified}=req.query;const accounts=await rows('accounts',[],'created_at',1000);let users=await rows('users',[],'created_at',1000);
  users=users.filter(u=>!isAdminUser(u)||accounts.some(a=>a.user_id===u.id&&a.account_type!=='Admin Account'));
  if(search)users=users.filter(u=>['first_name','last_name','email','phone'].some(k=>String(u[k]||'').toLowerCase().includes(String(search).toLowerCase())));
  if(status==='frozen')users=users.filter(u=>!!u.is_frozen);if(status==='active')users=users.filter(u=>!u.is_frozen);if(verified==='verified')users=users.filter(u=>!!u.is_verified);if(verified==='unverified')users=users.filter(u=>!u.is_verified);
  users=await Promise.all(users.map(async u=>({...u,accounts:(await rows('accounts',[{field:'user_id',value:id(u.id)}],'created_at',100)).map(display)})));
  res.render('admin/users',{title:'User Management - United Credit Bank',page:'admin-users',users,userAccounts:Object.fromEntries(users.map(u=>[u.id,u.accounts])),filters:req.query});
}catch(e){next(e);}});
router.get('/users/create',(_req,res)=>res.render('admin/user-create',{title:'Create Customer - United Credit Bank',page:'admin-users'}));
router.get('/users/:id',async(req,res,next)=>{try{
  const customer=await getUser(req.params.id);if(!customer){req.session.error='User not found.';return res.redirect('/admin/users');}
  const [accounts,txns,cards,loans,kyc,notifications,logs]=await Promise.all([rows('accounts',[{field:'user_id',value:id(customer.id)}],'created_at',100),rows('transactions',[{field:'user_id',value:id(customer.id)}],'created_at',50),rows('cards',[{field:'user_id',value:id(customer.id)}],'created_at',100),rows('loans',[{field:'user_id',value:id(customer.id)}],'created_at',100),rows('kyc',[{field:'user_id',value:id(customer.id)}],'submitted_at',100),rows('notifications',[{field:'user_id',value:id(customer.id)}],'created_at',20),rows('audit_logs',[{field:'target_id',value:id(customer.id)},{field:'target_type',value:'user'}],'created_at',20)]);
  const transactions=await Promise.all(txns.map(async t=>({...t,account_name:(await repo.get('accounts',id(t.account_id)))?.account_name||''})));const auditLogs=await Promise.all(logs.map(async l=>{const a=await getUser(l.admin_id);return {...l,admin_first:a?.first_name||'',admin_last:a?.last_name||''};}));
  const safeKyc=kyc.map(safeAdminKyc),safeCards=cards.map(safeAdminCard);
  res.render('admin/user-detail',{title:`User: ${customer.first_name} ${customer.last_name} - United Credit Bank`,page:'admin-users',user:customer,customer,accounts,transactions,cards:safeCards,loans,kyc:safeKyc,latestKyc:safeKyc[0]||null,notifications,logs:auditLogs,auditLogs,totalBalance:accounts.reduce((s,a)=>s+(a.balance||0),0),operationId:newOperationId()});
}catch(e){next(e);}});
router.get('/accounts',async(req,res,next)=>{try{let accounts=await accountsWithUsers();const{search,type,status}=req.query;if(search)accounts=accounts.filter(a=>['account_number','account_name','email','first_name','last_name'].some(k=>String(a[k]||'').toLowerCase().includes(String(search).toLowerCase())));if(type&&type!=='all')accounts=accounts.filter(a=>a.account_type===type);if(status&&status!=='all')accounts=accounts.filter(a=>a.status===status);res.render('admin/accounts',{title:'Account Management - United Credit Bank',page:'admin-accounts',accounts,filters:req.query});}catch(e){next(e);}});
router.get('/accounts/:id',async(req,res,next)=>{try{const a=display(await repo.get('accounts',req.params.id));if(!a){req.session.error='Account not found.';return res.redirect('/admin/accounts');}const[u,transactions,ledgerEntries]=await Promise.all([getUser(a.user_id),rows('transactions',[{field:'account_id',value:id(a.id)}],'created_at',100),rows('ledger_entries',[{field:'account_id',value:id(a.id)}],'created_at',200)]);const account={...a,first_name:u?.first_name||'',last_name:u?.last_name||'',email:u?.email||'',is_frozen:u?.is_frozen||false,user_name:`${u?.first_name||''} ${u?.last_name||''}`.trim()};res.render('admin/account-detail',{title:`Account ${a.account_number} - United Credit Bank`,page:'admin-accounts',account,transactions,ledgerEntries,operationId:newOperationId()});}catch(e){next(e);}});
router.get('/cards',async(req,res,next)=>{try{
  const q=req.query;
  let cards=await Promise.all((await rows('cards',[],'requested_at',200)).map(async c=>safeAdminCard({...await withUser(c),account_number:(await repo.get('accounts',id(c.account_id)))?.account_number||''})));
  if(q.search){const term=String(q.search).toLowerCase();cards=cards.filter(c=>[c.user_name,c.cardholder_name,c.card_last4,c.user_id].some(v=>String(v||'').toLowerCase().includes(term)));}
  if(q.type&&q.type!=='all')cards=cards.filter(c=>String(c.card_type||'').toLowerCase().includes(String(q.type).toLowerCase()));
  if(q.status&&q.status!=='all')cards=cards.filter(c=>c.status===q.status);
  res.render('admin/cards',{title:'Card Management - United Credit Bank',page:'admin-cards',cards,filters:q});
}catch(e){next(e);}});
router.get('/loans',async(req,res,next)=>{try{
  const q=req.query;
  let loans=await Promise.all((await rows('loans',[],'requested_at',200)).map(async l=>{
    const loan=display(l),u=await getUser(l.user_id),ps=await rows('loan_payments',[{field:'user_id',value:id(l.user_id)}],'created_at',500);
    return {...loan,first_name:u?.first_name||'',last_name:u?.last_name||'',email:u?.email||'',user_name:`${u?.first_name||''} ${u?.last_name||''}`.trim(),principal_amount:loan.loan_amount,monthly_payment:loan.monthly_repayment,total_amount:loan.total_repayment,term_months:loan.loan_term_months,amount_paid:(loan.total_repayment||0)-(loan.remaining_balance??loan.loan_amount??0),payment_count:ps.filter(p=>String(p.loan_id)===String(l.id)).length};
  }));
  if(q.search){const term=String(q.search).toLowerCase();loans=loans.filter(l=>[l.user_name,l.email,l.user_id,l.id].some(v=>String(v||'').toLowerCase().includes(term)));}
  if(q.type&&q.type!=='all')loans=loans.filter(l=>l.loan_type===q.type);
  if(q.status&&q.status!=='all')loans=loans.filter(l=>l.status===q.status);
  res.render('admin/loans',{title:'Loan Management - United Credit Bank',page:'admin-loans',loans,filters:q});
}catch(e){next(e);}});
router.get('/transactions',async(req,res,next)=>{try{
  const q=req.query;let ts=await rows('transactions',[],'created_at',500);
  ts=ts.filter(t=>(!q.user||String(t.user_id)===String(q.user))&&(!q.account||String(t.account_id)===String(q.account))&&(!q.type||q.type==='all'||t.transaction_type===q.type)&&(!q.status||q.status==='all'||t.status===q.status)&&(!q.from_date||String(t.created_at||'').slice(0,10)>=q.from_date)&&(!q.to_date||String(t.created_at||'').slice(0,10)<=q.to_date));
  let transactions=await Promise.all(ts.map(async t=>{const[u,a]=await Promise.all([getUser(t.user_id),repo.get('accounts',id(t.account_id))]);return {...display(t),first_name:u?.first_name||'',last_name:u?.last_name||'',email:u?.email||'',account_name:a?.account_name||'',account_number:a?.account_number||'',user_name:`${u?.first_name||''} ${u?.last_name||''}`.trim()};}));
  if(q.search){const term=String(q.search).toLowerCase();transactions=transactions.filter(t=>[t.id,t.user_name,t.email,t.reference,t.description,t.recipient_name,t.account_name,t.account_number,t.amount].some(v=>String(v||'').toLowerCase().includes(term)));}
  const min=Number(q.min_amount),max=Number(q.max_amount);if(q.min_amount!==undefined&&q.min_amount!==''&&Number.isFinite(min))transactions=transactions.filter(t=>Math.abs(Number(t.amount)||0)>=min);if(q.max_amount!==undefined&&q.max_amount!==''&&Number.isFinite(max))transactions=transactions.filter(t=>Math.abs(Number(t.amount)||0)<=max);
  const accounts=await accountsWithUsers();const totals={volume:transactions.reduce((s,t)=>s+(t.amount||0),0),completed:transactions.filter(t=>t.status==='completed').length,pending:transactions.filter(t=>t.status==='pending').length};
  res.render('admin/transactions',{title:'All Transactions - United Credit Bank',page:'admin-transactions',transactions,accounts,filters:q,totals});
}catch(e){next(e);}});
router.get('/transactions/new', unavailable);
router.get('/transactions/:id',async(req,res,next)=>{try{const transaction=display(await repo.get('transactions',req.params.id));if(!transaction){req.session.error='Transaction not found.';return res.redirect('/admin/transactions');}const[user,account,ledgerEntries,billPayment]=await Promise.all([getUser(transaction.user_id),repo.get('accounts',id(transaction.account_id)),rows('ledger_entries',[{field:'transaction_id',value:id(transaction.id)}],'created_at',100),transaction.bill_payment_id?repo.get('bill_payments',id(transaction.bill_payment_id)):null]);res.render('admin/transaction-detail',{title:`Transaction ${transaction.id} - United Credit Bank`,page:'admin-transactions',transaction,user,account:display(account),ledgerEntries,billPayment:display(billPayment)});}catch(e){next(e);}});
router.get('/approvals',async(req,res,next)=>{try{
  const section=req.query.section||'all';
  async function getApprovals(kind,collection,sort){
    if(section!=='all'&&section!==kind)return[];
    const rs=await rows(collection,[{field:'status',value:'pending'}],sort,500);
    return Promise.all(rs.map(async r=>{
      let x=await withUser(r);
      if(kind==='cards')x=safeAdminCard(x);
      if(kind==='kyc')x=safeAdminKyc(x);
      if(r.account_id){const a=await repo.get('accounts',id(r.account_id));x.account_name=a?.account_name||'';x.account_number=a?.account_number||'';}
      if(kind==='loans'){Object.assign(x,{principal_amount:r.loan_amount,monthly_payment:r.monthly_repayment,total_amount:r.total_repayment,term_months:r.loan_term_months});x.customer_accounts=(await rows('accounts',[{field:'user_id',value:id(r.user_id)}],'created_at',100)).filter(a=>String(a.status||'active')==='active');}
      if(kind==='bills')x.customer_ref=r.reference_number;
      return x;
    }));
  }
  const [kyc,transfers,cards,loans,bills]=await Promise.all([getApprovals('kyc','kyc','submitted_at'),getApprovals('transfers','transactions','created_at'),getApprovals('cards','cards','requested_at'),getApprovals('loans','loans','requested_at'),getApprovals('bills','bill_payments','created_at')]);
  const data={kyc,transfers,cards,loans,bills};
  res.render('admin/approvals',{title:'Approvals - United Credit Bank',page:'admin-approvals',...data,section,pendingKYC:kyc,pendingTransfers:transfers,pendingCards:cards,pendingLoans:loans,pendingBills:bills});
}catch(e){next(e);}});
router.get('/audit-logs',async(_req,res,next)=>{try{const logs=await Promise.all((await rows('audit_logs',[],'created_at',500)).map(async l=>{const u=await getUser(l.admin_id);return {...l,first_name:u?.first_name||'',last_name:u?.last_name||'',email:u?.email||'',admin_name:`${u?.first_name||''} ${u?.last_name||''}`.trim()};}));res.render('admin/audit-logs',{title:'Audit Logs - United Credit Bank',page:'admin-audit',logs,auditLogs:logs});}catch(e){next(e);}});
router.get('/settings',async(_req,res,next)=>{try{const admins=(await rows('users',[],'created_at',500)).filter(isAdminUser);res.render('admin/settings',{title:'Admin Settings - United Credit Bank',page:'admin-settings',admins});}catch(e){next(e);}});
router.get('/reports',async(_req,res,next)=>{try{
  const [transactions,accounts,loans,users]=await Promise.all([rows('transactions',[],'created_at',1000),rows('accounts',[],'created_at',1000),rows('loans',[],'created_at',1000),rows('users',[],'created_at',1000)]);
  const now=new Date(),monthKeys=[];
  for(let offset=11;offset>=0;offset--){const d=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()-offset,1));monthKeys.push({key:d.toISOString().slice(0,7),month:d.toLocaleString('en-AU',{month:'short',timeZone:'UTC'}),new_customers:0,deposits:0,withdrawals:0});}
  const monthMap=new Map(monthKeys.map(m=>[m.key,m]));
  for(const user of users){const item=monthMap.get(String(user.created_at||'').slice(0,7));if(item&&!isAdminUser(user))item.new_customers+=1;}
  for(const txn of transactions){const item=monthMap.get(String(txn.created_at||'').slice(0,7));if(!item||txn.status!=='completed')continue;const amount=Math.abs(Number(txn.amount)||0);if(txn.transaction_type==='deposit')item.deposits+=amount;if(txn.transaction_type==='withdrawal')item.withdrawals+=amount;}
  const cutoff=new Date(now.getTime()-30*24*60*60*1000).toISOString();
  const recent=transactions.filter(t=>String(t.created_at||'')>=cutoff);
  const revenue=recent.filter(t=>t.status==='completed').reduce((sum,t)=>sum+Math.max(0,Number(t.fee)||0),0);
  const deposits30d=recent.filter(t=>t.status==='completed'&&t.transaction_type==='deposit').reduce((sum,t)=>sum+Math.max(0,Number(t.amount)||0),0);
  const byType=new Map();for(const txn of recent){const type=String(txn.transaction_type||'unknown');const entry=byType.get(type)||{type,count:0,total:0};entry.count+=1;entry.total+=Math.abs(Number(txn.amount)||0);byType.set(type,entry);}
  const typeBreakdown=[...byType.values()].sort((a,b)=>b.count-a.count);
  const accountMap=new Map();for(const account of accounts){const type=String(account.account_type||'Unknown');const entry=accountMap.get(type)||{type,count:0,total_balance:0};entry.count+=1;entry.total_balance+=Number(account.balance)||0;accountMap.set(type,entry);}
  const accountSummary=[...accountMap.values()].sort((a,b)=>b.count-a.count);
  const activeLoans=loans.filter(l=>['active','disbursed'].includes(String(l.status)));
  const loanTotals={count:activeLoans.length,total_outstanding:activeLoans.reduce((sum,l)=>sum+Number(l.remaining_balance??l.loan_amount??0),0)};
  const loanMap=new Map();for(const loan of activeLoans){const type=String(loan.loan_type||'Unknown');const entry=loanMap.get(type)||{type,count:0,outstanding:0,monthly_total:0,rate_total:0};entry.count+=1;entry.outstanding+=Number(loan.remaining_balance??loan.loan_amount??0);entry.monthly_total+=Number(loan.monthly_repayment)||0;entry.rate_total+=Number(loan.interest_rate)||0;loanMap.set(type,entry);}
  const loanSummary=[...loanMap.values()].map(x=>({...x,avg_rate:x.count?x.rate_total/x.count:0})).sort((a,b)=>b.outstanding-a.outstanding);
  res.render('admin/reports',{title:'Reports & Analytics - United Credit Bank',page:'admin-reports',revenue,deposits30d,monthlyData:monthKeys,typeBreakdown,accountSummary,loanSummary,loanTotals,coverage:{transactions:transactions.length,accounts:accounts.length,loans:loans.length,users:users.length,limited:true}});
}catch(e){next(e);}});
registerAdminPost('/users/create', async req => {
  const identity = await signUpWithPassword(String(req.body.email || '').trim().toLowerCase(), crypto.randomBytes(32).toString('base64url'), { displayName: `${req.body.first_name || ''} ${req.body.last_name || ''}`.trim() });
  if (!identity.localId || !identity.idToken) throw Object.assign(new Error('Firebase did not return the new customer identity.'), { status: 502 });
  let result;
  try {
    result = await adminWorkflows.createCustomer({ actorId: req.auth.uid, userId: identity.localId, body: req.body, ipAddress: req.ip });
  } catch (error) {
    if (Number(error.status) > 0 && Number(error.status) < 500) {
      try { await deleteFirebaseUser(identity.idToken); } catch (cleanupError) { console.error('Failed to roll back the new Firebase identity after a definite Firestore validation failure:', cleanupError.message); }
    } else {
      console.error('Firestore customer creation outcome is ambiguous; retaining the Firebase identity for reconciliation:', error.message);
    }
    throw error;
  }
  try { await sendPasswordResetEmail(String(req.body.email).trim().toLowerCase()); result.passwordResetSent = true; }
  catch (error) { console.error('Customer profile created but password-reset email delivery was not confirmed:', error.message); result.passwordResetSent = false; }
  return result;
}, result => `Customer created with Firebase UID ${result.userId}; a password-reset email was requested.`, (_req, result) => result && result.userId ? `/admin/users/${encodeURIComponent(result.userId)}` : '/admin/users/create');
registerAdminPost('/users/:id/accounts', req => adminWorkflows.createAccount({ actorId: req.auth.uid, targetId: req.params.id, body: req.body, ipAddress: req.ip }), result => `Zero-balance account ${result.accountNumber} opened and audited.`, req => `/admin/users/${encodeURIComponent(req.params.id)}`);
registerAdminPost('/users/:id/disable', req => adminWorkflows.disableCustomer({ actorId: req.auth.uid, targetId: req.params.id, reason: req.body && req.body.reason, ipAddress: req.ip }), 'Customer access disabled; financial history retained and audited.', req => `/admin/users/${encodeURIComponent(req.params.id)}`);
registerAdminPost('/users/:id/restore', req => adminWorkflows.restoreCustomer({ actorId: req.auth.uid, targetId: req.params.id, reason: req.body && req.body.reason, ipAddress: req.ip }), 'Customer access restored and audited.', req => `/admin/users/${encodeURIComponent(req.params.id)}`);
registerAdminPost('/users/:id/password-reset', async req => {
  const { email } = await adminWorkflows.recordPasswordResetRequest({ actorId: req.auth.uid, targetId: req.params.id, reason: req.body && req.body.reason, ipAddress: req.ip });
  await sendPasswordResetEmail(email);
  return { changed: true };
}, 'Firebase password-reset email requested and the attempt was audited.', req => `/admin/users/${encodeURIComponent(req.params.id)}`);
registerAdminPost('/users/:id/update', req => adminWorkflows.updateUserProfile({ actorId: req.auth.uid, targetId: req.params.id, body: req.body, ipAddress: req.ip }), 'Customer profile updated and audit logged.', req => `/admin/users/${encodeURIComponent(req.params.id)}`);
registerAdminPost('/users/:id/freeze', req => adminWorkflows.setUserFrozen({ actorId: req.auth.uid, targetId: req.params.id, action: 'freeze', reason: req.body && req.body.reason, ipAddress: req.ip }), 'Customer frozen and audit logged.', req => `/admin/users/${encodeURIComponent(req.params.id)}`);
registerAdminPost('/users/:id/unfreeze', req => adminWorkflows.setUserFrozen({ actorId: req.auth.uid, targetId: req.params.id, action: 'unfreeze', reason: req.body && req.body.reason, ipAddress: req.ip }), 'Customer unfrozen and audit logged.', req => `/admin/users/${encodeURIComponent(req.params.id)}`);
registerAdminPost('/accounts/:id/update', req => adminWorkflows.updateAccountMetadata({ actorId: req.auth.uid, accountId: req.params.id, body: req.body, ipAddress: req.ip }), 'Account metadata updated and audit logged.', req => `/admin/accounts/${encodeURIComponent(req.params.id)}`);
registerAdminPost('/accounts/:id/status', req => adminWorkflows.changeAccountStatus({ actorId: req.auth.uid, accountId: req.params.id, status: req.body && req.body.status, reason: req.body && req.body.reason, ipAddress: req.ip }), 'Account status updated and audit logged.', req => `/admin/accounts/${encodeURIComponent(req.params.id)}`);
registerAdminPost('/accounts/:id/balance-adjustment', req => adminWorkflows.adjustAccountBalance({ actorId: req.auth.uid, accountId: req.params.id, body: { ...req.body, account_id: req.params.id }, ipAddress: req.ip }), result => `Balance adjustment transaction ${result.transactionId} committed to the account ledger.`, req => `/admin/accounts/${encodeURIComponent(req.params.id)}`);
registerAdminPost('/cards/:id/status', req => adminWorkflows.changeCardStatus({ actorId: req.auth.uid, cardId: req.params.id, status: req.body && req.body.status, reason: req.body && req.body.reason, ipAddress: req.ip }), 'Card status changed and audited.', req => '/admin/cards');
registerAdminPost('/approvals/:kind/:id/review', async req => {
  const kind = String(req.params.kind || ''), action = String(req.body && req.body.action || '');
  const common = { actorId: req.auth.uid, action, body: req.body, ipAddress: req.ip };
  if (kind === 'transfers') return adminWorkflows.reviewTransaction({ ...common, transactionId: req.params.id });
  if (kind === 'bills') return adminWorkflows.reviewBillPayment({ ...common, billPaymentId: req.params.id });
  if (kind === 'cards') return adminWorkflows.reviewCard({ ...common, cardId: req.params.id });
  if (kind === 'loans') return adminWorkflows.reviewLoan({ ...common, loanId: req.params.id });
  if (kind === 'kyc') {
    const record = await repo.get('kyc', req.params.id);
    if (!record) throw Object.assign(new Error('KYC record not found.'), { status: 404 });
    const documentEvidence = {};
    if (action === 'approve') {
      if (!req.body || req.body.documents_reviewed !== 'yes') throw Object.assign(new Error('Confirm that you downloaded and reviewed the required identity documents before approving KYC.'), { status: 400 });
      const requiredFields = ['document_front'];
      if (['Drivers Licence', 'Proof of Age', 'Medicare'].includes(String(record.document_type || ''))) requiredFields.push('document_back');
      if (record.document_selfie) requiredFields.push('document_selfie');
      for (const field of requiredFields) {
        const objectName = String(record[field] || '');
        if (!objectName.startsWith(`kyc/${String(record.user_id)}/`)) throw Object.assign(new Error('The submitted identity document could not be verified in Firebase Storage.'), { status: 409 });
        const file = await downloadObject(objectName);
        if (!file.bytes || !file.bytes.byteLength) throw Object.assign(new Error('The submitted identity document is empty or unavailable.'), { status: 409 });
        documentEvidence[field] = objectName;
      }
    }
    const workflowBody = { ...(req.body || {}) };
    delete workflowBody.documents_reviewed;
    return adminWorkflows.reviewKyc({ ...common, body: workflowBody, recordId: req.params.id, documentEvidence });
  }
  throw Object.assign(new Error('Unknown admin review queue.'), { status: 404 });
}, result => `Review decision recorded and audited: ${result.status}.`, req => `/admin/approvals?section=${encodeURIComponent(req.params.kind)}`);
// Financial history is immutable: operational outcomes append transactions and ledger entries; no legacy hard-delete or history-edit route is exposed.
router.all('*',(_req,res)=>res.status(503).render('error',{title:'Temporarily unavailable',message:'This administrative operation is unavailable until its Firestore transaction, integer-minor-unit, immutable-ledger, and audit handling are migrated.'}));
module.exports=router;
