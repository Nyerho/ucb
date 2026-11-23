'use strict';
const express = require('express');
const { createFirestoreRepository } = require('../services/firestore-rest');
const { fromMinorUnits } = require('../services/money');
const { requireAdmin } = require('../middleware/auth');
const router = express.Router();
const repo = createFirestoreRepository();
router.use(require('../middleware/production-financial-gate'));
router.use(requireAdmin);
const id = value => String(value);
const display = row => {
  if (!row) return row;
  const out = { ...row };
  for (const key of Object.keys(out)) if (key.endsWith('_minor') && Number.isSafeInteger(out[key])) out[key.slice(0, -6)] = fromMinorUnits(out[key]);
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
async function accountsWithUsers() {
  return Promise.all((await rows('accounts', [], 'created_at', 500)).map(async a => {
    const u = await getUser(a.user_id);
    return { ...a, first_name: u?.first_name || '', last_name: u?.last_name || '', email: u?.email || '', is_frozen: u?.is_frozen || false, user_name: `${u?.first_name || ''} ${u?.last_name || ''}`.trim() };
  }));
}
function unavailable(_req, res) {
  return res.status(503).render('error', { title: 'Temporarily unavailable', message: 'This administrative operation is unavailable until its Firestore transaction, integer-minor-unit, immutable-ledger, and audit handling are migrated.' });
}
router.get('/dashboard', async (req, res, next) => {
  try {
    const [users, accounts, transactions, cards, loans, kyc, bills] = await Promise.all([
      rows('users', [], 'created_at', 1000), rows('accounts', [], 'created_at', 1000), rows('transactions', [], 'created_at', 1000),
      rows('cards', [], 'created_at', 1000), rows('loans', [], 'created_at', 1000), rows('kyc', [{ field: 'status', value: 'pending' }], 'submitted_at', 1000), rows('bill_payments', [{ field: 'status', value: 'pending' }], 'created_at', 1000)
    ]);
    const customers = users.filter(u => !u.is_admin || accounts.some(a => a.user_id === u.id && a.account_type !== 'Admin Account'));
    const recentTransactions = await Promise.all(transactions.slice(0, 10).map(async t => { const [u,a] = await Promise.all([getUser(t.user_id),repo.get('accounts',id(t.account_id))]); return { ...display(t), first_name:u?.first_name||'',last_name:u?.last_name||'',account_name:a?.account_name||'' }; }));
    const recentUsers = customers.slice(0,5).map(u => ({...u,account_count:accounts.filter(a=>a.user_id===u.id).length}));
    const total = (rs,k) => rs.reduce((s,r)=>s+(Number.isSafeInteger(r[`${k}_minor`])?r[`${k}_minor`]:0),0)/100;
    const date = new Date().toISOString().slice(0,10);
    const todays = transactions.filter(t=>String(t.created_at||'').slice(0,10)===date);
    const stats = { totalUsers:customers.length,totalCustomers:customers.length,totalAccounts:accounts.length,totalCards:cards.length,totalLoans:loans.length,pendingKYC:kyc.length,pendingTransfers:transactions.filter(t=>t.status==='pending').length,pendingCards:cards.filter(c=>c.status==='pending').length,pendingLoans:loans.filter(l=>l.status==='pending').length,pendingBills:bills.length,frozenAccounts:users.filter(u=>u.is_frozen).length,totalBalance:total(accounts,'balance'),totalDeposits:total(accounts,'balance'),loansDisbursed:total(loans.filter(l=>l.status==='disbursed'),'loan_amount'),totalLoansOutstanding:total(loans.filter(l=>l.status==='disbursed'),'remaining_balance'),recentUsers,recentTransactions,todayTransactions:todays.length,todayVolume:total(todays,'amount'),newThisWeek:0,activeCards:cards.filter(c=>['approved','active'].includes(c.status)).length,activeLoans:loans.filter(l=>l.status==='disbursed').length,unverifiedCustomers:customers.filter(u=>!u.is_verified).length };
    const admin=await getUser(req.session.userId);
    res.render('admin/dashboard',{title:'Admin Dashboard - United Credit Bank',page:'admin-dashboard',admin,user:admin,stats,pendingCount:stats.pendingKYC+stats.pendingTransfers+stats.pendingCards+stats.pendingLoans+stats.pendingBills,recentUsers,recentTransactions});
  } catch(e){next(e);}
});
router.get('/users',async(req,res,next)=>{try{
  const {search,status,verified}=req.query;const accounts=await rows('accounts',[],'created_at',1000);let users=await rows('users',[],'created_at',1000);
  users=users.filter(u=>!u.is_admin||accounts.some(a=>a.user_id===u.id&&a.account_type!=='Admin Account'));
  if(search)users=users.filter(u=>['first_name','last_name','email','phone'].some(k=>String(u[k]||'').toLowerCase().includes(String(search).toLowerCase())));
  if(status==='frozen')users=users.filter(u=>!!u.is_frozen);if(status==='active')users=users.filter(u=>!u.is_frozen);if(verified==='verified')users=users.filter(u=>!!u.is_verified);if(verified==='unverified')users=users.filter(u=>!u.is_verified);
  users=await Promise.all(users.map(async u=>({...u,accounts:(await rows('accounts',[{field:'user_id',value:id(u.id)}],'created_at',100)).map(display)})));
  res.render('admin/users',{title:'User Management - United Credit Bank',page:'admin-users',users,userAccounts:Object.fromEntries(users.map(u=>[u.id,u.accounts])),filters:req.query});
}catch(e){next(e);}});
router.get('/users/create',(_req,res)=>res.render('admin/user-create',{title:'Create User - United Credit Bank',page:'admin-users'}));
router.get('/users/:id',async(req,res,next)=>{try{
  const customer=await getUser(req.params.id);if(!customer){req.session.error='User not found.';return res.redirect('/admin/users');}
  const [accounts,txns,cards,loans,kyc,notifications,logs]=await Promise.all([rows('accounts',[{field:'user_id',value:id(customer.id)}],'created_at',100),rows('transactions',[{field:'user_id',value:id(customer.id)}],'created_at',50),rows('cards',[{field:'user_id',value:id(customer.id)}],'created_at',100),rows('loans',[{field:'user_id',value:id(customer.id)}],'created_at',100),rows('kyc',[{field:'user_id',value:id(customer.id)}],'submitted_at',100),rows('notifications',[{field:'user_id',value:id(customer.id)}],'created_at',20),rows('audit_logs',[{field:'target_id',value:id(customer.id)},{field:'target_type',value:'user'}],'created_at',20)]);
  const transactions=await Promise.all(txns.map(async t=>({...t,account_name:(await repo.get('accounts',id(t.account_id)))?.account_name||''})));const auditLogs=await Promise.all(logs.map(async l=>{const a=await getUser(l.admin_id);return {...l,admin_first:a?.first_name||'',admin_last:a?.last_name||''};}));
  res.render('admin/user-detail',{title:`User: ${customer.first_name} ${customer.last_name} - United Credit Bank`,page:'admin-users',user:customer,customer,accounts,transactions,cards,loans,kyc,latestKyc:kyc[0]||null,notifications,logs:auditLogs,auditLogs,totalBalance:accounts.reduce((s,a)=>s+(a.balance||0),0)});
}catch(e){next(e);}});
router.get('/accounts',async(req,res,next)=>{try{let accounts=await accountsWithUsers();const{search,type,status}=req.query;if(search)accounts=accounts.filter(a=>['account_number','account_name','email','first_name','last_name'].some(k=>String(a[k]||'').toLowerCase().includes(String(search).toLowerCase())));if(type&&type!=='all')accounts=accounts.filter(a=>a.account_type===type);if(status&&status!=='all')accounts=accounts.filter(a=>a.status===status);res.render('admin/accounts',{title:'Account Management - United Credit Bank',page:'admin-accounts',accounts,filters:req.query});}catch(e){next(e);}});
router.get('/accounts/:id',async(req,res,next)=>{try{const a=display(await repo.get('accounts',req.params.id));if(!a){req.session.error='Account not found.';return res.redirect('/admin/accounts');}const[u,transactions]=await Promise.all([getUser(a.user_id),rows('transactions',[{field:'account_id',value:id(a.id)}],'created_at',100)]);const account={...a,first_name:u?.first_name||'',last_name:u?.last_name||'',email:u?.email||'',is_frozen:u?.is_frozen||false,user_name:`${u?.first_name||''} ${u?.last_name||''}`.trim()};res.render('admin/account-detail',{title:`Account ${a.account_number} - United Credit Bank`,page:'admin-accounts',account,transactions});}catch(e){next(e);}});
router.get('/cards',async(_req,res,next)=>{try{const cards=await Promise.all((await rows('cards',[],'requested_at',200)).map(async c=>({...await withUser(c),account_number:(await repo.get('accounts',id(c.account_id)))?.account_number||''})));res.render('admin/cards',{title:'Card Management - United Credit Bank',page:'admin-cards',cards});}catch(e){next(e);}});
router.get('/loans',async(_req,res,next)=>{try{const loans=await Promise.all((await rows('loans',[],'requested_at',200)).map(async l=>{const u=await getUser(l.user_id);const ps=await rows('loan_payments',[{field:'user_id',value:id(l.user_id)}],'created_at',500);return {...display(l),first_name:u?.first_name||'',last_name:u?.last_name||'',email:u?.email||'',user_name:`${u?.first_name||''} ${u?.last_name||''}`.trim(),principal_amount:l.loan_amount,monthly_payment:l.monthly_repayment,total_amount:l.total_repayment,term_months:l.loan_term_months,amount_paid:(l.total_repayment||0)-(l.remaining_balance??l.loan_amount??0),payment_count:ps.filter(p=>String(p.loan_id)===String(l.id)).length};}));res.render('admin/loans',{title:'Loan Management - United Credit Bank',page:'admin-loans',loans});}catch(e){next(e);}});
router.get('/transactions',async(req,res,next)=>{try{let ts=await rows('transactions',[],'created_at',500);const q=req.query;ts=ts.filter(t=>(!q.user||String(t.user_id)===String(q.user))&&(!q.account||String(t.account_id)===String(q.account))&&(!q.type||q.type==='all'||t.transaction_type===q.type)&&(!q.status||q.status==='all'||t.status===q.status));const transactions=await Promise.all(ts.map(async t=>{const[u,a]=await Promise.all([getUser(t.user_id),repo.get('accounts',id(t.account_id))]);return {...display(t),first_name:u?.first_name||'',last_name:u?.last_name||'',email:u?.email||'',account_name:a?.account_name||'',account_number:a?.account_number||'',user_name:`${u?.first_name||''} ${u?.last_name||''}`.trim()};}));const accounts=await accountsWithUsers();const totals={volume:transactions.reduce((s,t)=>s+(t.amount||0),0),completed:transactions.filter(t=>t.status==='completed').length,pending:transactions.filter(t=>t.status==='pending').length};res.render('admin/transactions',{title:'All Transactions - United Credit Bank',page:'admin-transactions',transactions,accounts,filters:q,totals});}catch(e){next(e);}});
router.get('/transactions/new',async(req,res,next)=>{try{res.render('admin/transaction-form',{title:'Create Transaction - United Credit Bank',page:'admin-transactions',transaction:null,accounts:await accountsWithUsers(),filters:req.query});}catch(e){next(e);}});
router.get('/transactions/:id',async(req,res,next)=>{try{const t=display(await repo.get('transactions',req.params.id));if(!t){req.session.error='Transaction not found.';return res.redirect('/admin/transactions');}const[u,a,accounts]=await Promise.all([getUser(t.user_id),repo.get('accounts',id(t.account_id)),accountsWithUsers()]);Object.assign(t,{first_name:u?.first_name||'',last_name:u?.last_name||'',email:u?.email||'',account_number:a?.account_number||'',account_name:a?.account_name||'',user_name:`${u?.first_name||''} ${u?.last_name||''}`.trim()});res.render('admin/transaction-form',{title:`Transaction #${t.id} - United Credit Bank`,page:'admin-transactions',transaction:t,accounts,filters:{}});}catch(e){next(e);}});
router.get('/approvals',async(req,res,next)=>{try{const section=req.query.section||'all';async function getApprovals(kind,collection,sort){if(section!=='all'&&section!==kind)return[];const rs=await rows(collection,[{field:'status',value:'pending'}],sort,500);return Promise.all(rs.map(async r=>{const x=await withUser(r);if(r.account_id){const a=await repo.get('accounts',id(r.account_id));x.account_name=a?.account_name||'';x.account_number=a?.account_number||'';}if(kind==='loans')Object.assign(x,{principal_amount:r.loan_amount,monthly_payment:r.monthly_repayment,total_amount:r.total_repayment,term_months:r.loan_term_months});if(kind==='bills')x.customer_ref=r.reference_number;return x;}));}const [kyc,transfers,cards,loans,bills]=await Promise.all([getApprovals('kyc','kyc','submitted_at'),getApprovals('transfers','transactions','created_at'),getApprovals('cards','cards','requested_at'),getApprovals('loans','loans','requested_at'),getApprovals('bills','bill_payments','created_at')]);const data={kyc,transfers,cards,loans,bills};res.render('admin/approvals',{title:'Approvals - United Credit Bank',page:'admin-approvals',...data,section,pendingKYC:kyc,pendingTransfers:transfers,pendingCards:cards,pendingLoans:loans,pendingBills:bills});}catch(e){next(e);}});
router.get('/audit-logs',async(_req,res,next)=>{try{const logs=await Promise.all((await rows('audit_logs',[],'created_at',500)).map(async l=>{const u=await getUser(l.admin_id);return {...l,first_name:u?.first_name||'',last_name:u?.last_name||'',email:u?.email||'',admin_name:`${u?.first_name||''} ${u?.last_name||''}`.trim()};}));res.render('admin/audit-logs',{title:'Audit Logs - United Credit Bank',page:'admin-audit',logs,auditLogs:logs});}catch(e){next(e);}});
router.get('/settings',async(_req,res,next)=>{try{const admins=(await rows('users',[],'created_at',500)).filter(u=>u.is_admin);res.render('admin/settings',{title:'Admin Settings - United Credit Bank',page:'admin-settings',admins});}catch(e){next(e);}});
// Preserve legacy write URLs, but reject until every mutation has safe Firestore transaction and immutable ledger semantics.
router.all('*',(_req,res)=>res.status(503).render('error',{title:'Temporarily unavailable',message:'This administrative operation is unavailable until its Firestore transaction, integer-minor-unit, immutable-ledger, and audit handling are migrated.'}));
module.exports=router;
