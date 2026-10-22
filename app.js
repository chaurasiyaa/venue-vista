const grid=document.querySelector('#grid');
const count=document.querySelector('#count');
const empty=document.querySelector('#empty');
const locationInput=document.querySelector('#location');
const occasion=document.querySelector('#occasion');
const authDialog=document.querySelector('#auth-dialog');
const authStatus=document.querySelector('#auth-status');
let venues=[];
let user=null;
let favorites=new Set();
let category='all';
let showSavedOnly=false;
let selectedVenue=null;
let pendingBookingVenue=null;
let paymentConfig={enabled:false,keyId:''};
let toastTimer;

async function api(url,options={}){
 const response=await fetch(url,{...options,headers:{...(options.body?{'Content-Type':'application/json'}:{}),...(options.headers||{})},credentials:'same-origin'});
 const data=await response.json().catch(()=>({error:'The server returned an invalid response.'}));
 if(!response.ok)throw new Error(data.error||'Something went wrong.');
 return data;
}
function escapeHtml(value){return String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));}
function showToast(message){const toast=document.querySelector('#toast');toast.textContent=message;toast.classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>toast.classList.remove('visible'),3500);}
function setStatus(element,message,error=false){element.textContent=message;element.classList.toggle('error',error);}
function formatMoney(paise){return new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:0}).format(Number(paise||0)/100);}
async function refreshFavorites(){if(!user){favorites=new Set();return;}const data=await api('/api/favorites');favorites=new Set(data.venueIds);}
async function loadVenues(){
 const params=new URLSearchParams();
 if(locationInput.value.trim())params.set('q',locationInput.value.trim());
 if(category!=='all')params.set('kind',category);
 if(occasion.value!=='all')params.set('occasion',occasion.value);
 const data=await api('/api/venues?'+params.toString());venues=data.venues;
 render();
}
function render(){
 const list=showSavedOnly?venues.filter(v=>favorites.has(v.id)):venues;
 count.textContent=String(list.length).padStart(2,'0')+' '+(list.length===1?'space':'spaces')+' to explore';
 empty.hidden=list.length>0;
  grid.innerHTML=list.map(v=>'<article class="card"><div class="photo"><img src="https://images.unsplash.com/'+encodeURIComponent(v.image)+'?auto=format&fit=crop&w=900&q=82" alt="'+escapeHtml(v.alt)+'" loading="lazy"><span class="tag">'+escapeHtml(v.kind)+'</span><button class="save '+(favorites.has(v.id)?'on':'')+'" data-save="'+v.id+'" aria-label="'+(favorites.has(v.id)?'Remove':'Save')+' '+escapeHtml(v.name)+'" aria-pressed="'+favorites.has(v.id)+'">'+(favorites.has(v.id)?'♥':'♡')+'</button></div><div class="details"><div class="title-line"><h3>'+escapeHtml(v.name)+'</h3><span class="rating">★ '+Number(v.rating).toFixed(1)+' <span style="color:#909890">('+Number(v.reviews)+')</span></span></div><p class="location">⌖ &nbsp;'+escapeHtml(v.area)+', '+escapeHtml(v.city)+'</p><div class="meta"><span>Up to '+Number(v.capacity)+' guests</span><span>Full venue price <strong>'+escapeHtml(v.price)+'</strong></span><button class="text-action" data-view="'+v.id+'" type="button">View ↗</button></div></div></article>').join('');
 grid.querySelectorAll('[data-save]').forEach(button=>button.addEventListener('click',()=>toggleFavorite(Number(button.dataset.save))));
 grid.querySelectorAll('[data-view]').forEach(button=>button.addEventListener('click',()=>openVenue(Number(button.dataset.view))));
 grid.querySelectorAll('.photo img').forEach(img=>img.addEventListener('error',()=>{img.classList.add('image-unavailable');img.alt='Venue photo unavailable';},{once:true}));
}
async function toggleFavorite(id){
 if(!user){openAuth('login');showToast('Sign in to save venues.');return;}
 const saved=favorites.has(id);
 try{await api('/api/favorites/'+id,{method:saved?'DELETE':'PUT'});saved?favorites.delete(id):favorites.add(id);render();}
 catch(error){showToast(error.message);if(error.message.includes('Sign in'))openAuth('login');}
}
function openAuth(mode='login'){
 document.querySelector('#auth-status').textContent='';
 const signedIn=Boolean(user);
 document.querySelector('#auth-view').hidden=signedIn;
 document.querySelector('#account-view').hidden=!signedIn;
 if(signedIn){document.querySelector('#auth-title').textContent='Your account.';document.querySelector('#auth-subtitle').textContent=user.userType==='owner'?'Manage your spaces and incoming booking requests.':'Your saved spaces and booking requests, all in one place.';document.querySelector('#account-name').textContent=user.name;document.querySelector('#customer-workspace').hidden=user.userType==='owner';document.querySelector('#owner-workspace').hidden=user.userType!=='owner';user.userType==='owner'?loadOwnerWorkspace():loadBookings();}
 else setAuthMode(mode);
 authDialog.showModal();
}
function setAuthMode(mode){
 const register=mode==='register';
 document.querySelector('#auth-title').textContent=register?'Create your account.':'Welcome back.';
 document.querySelector('#auth-subtitle').textContent=register?'Save favourite spaces and manage your booking requests.':'Sign in to save spaces and keep track of your requests.';
 document.querySelector('#name-field').hidden=!register;
 document.querySelector('#account-type-field').hidden=!register;
 document.querySelector('#auth-name').required=register;
 document.querySelector('#auth-password').autocomplete=register?'new-password':'current-password';
 document.querySelector('#auth-submit').textContent=register?'Create account':'Sign in';
 document.querySelector('#switch-mode').innerHTML=register?'Already have an account? <button type="button" id="mode-switch">Sign in</button>':'New here? <button type="button" id="mode-switch">Create an account</button>';
 document.querySelector('#mode-switch').addEventListener('click',()=>setAuthMode(register?'login':'register'));
}
async function loadBookings(){
 const list=document.querySelector('#booking-list');list.innerHTML='<p class="form-help">Loading your requests…</p>';
 try{const data=await api('/api/bookings');list.innerHTML=data.bookings.length?data.bookings.map(b=>'<article class="booking-item"><div><strong>'+escapeHtml(b.venueName)+'</strong><p>'+escapeHtml(b.city)+' · '+escapeHtml(b.date)+' · '+Number(b.guests)+' guests</p><p class="booking-amount">Full price: '+formatMoney(b.amountPaise)+'</p><span class="booking-status '+(b.status==='Cancelled'||b.status==='Expired'||b.status==='Declined'?'cancelled':'')+'">'+escapeHtml(b.status)+'</span></div><div class="booking-actions">'+(['Approved','Awaiting Payment','Expired'].includes(b.status)?(paymentConfig.enabled?'<button class="quiet-button pay-booking" type="button" data-pay="'+b.id+'">'+(b.paymentOrderId?'Continue payment':'Pay now')+'</button>':'<span class="form-help">Payment setup needed</span>'):'')+(b.status==='Pending'?'<span class="form-help">Waiting for venue approval</span>':'')+(['Pending','Approved','Expired'].includes(b.status)?'<button class="quiet-button cancel-booking" type="button" data-cancel="'+b.id+'">Cancel</button>':'')+'</div></article>').join(''):'<p class="form-help">No booking requests yet. Explore a space to get started.</p>';list.querySelectorAll('[data-cancel]').forEach(button=>button.addEventListener('click',async()=>{if(!window.confirm('Cancel this booking request?'))return;try{await api('/api/bookings/'+button.dataset.cancel,{method:'DELETE'});loadBookings();showToast('Booking request cancelled.');}catch(error){showToast(error.message);}}));list.querySelectorAll('[data-pay]').forEach(button=>button.addEventListener('click',()=>startCheckout(Number(button.dataset.pay),button.dataset.venue||'')));}
 catch(error){list.innerHTML='<p class="form-status error">'+escapeHtml(error.message)+'</p>';}
}
async function loadOwnerWorkspace(){
 const venuesEl=document.querySelector('#owner-venues'), bookingsEl=document.querySelector('#owner-bookings');
 try{
  const [vd,bd]=await Promise.all([api('/api/owner/venues'),api('/api/owner/bookings')]);
  venuesEl.innerHTML=vd.venues.length?vd.venues.map(v=>'<article class="booking-item"><div><strong>'+escapeHtml(v.name)+'</strong><p>'+escapeHtml(v.area)+', '+escapeHtml(v.city)+' · '+escapeHtml(v.kind)+' · '+v.capacity+' guests</p><p class="booking-amount">Full price: '+formatMoney(v.price_paise)+'</p></div></article>').join(''):'<p class="form-help">No spaces listed yet. Add your first venue below.</p>';
  bookingsEl.innerHTML=bd.bookings.length?bd.bookings.map(b=>'<article class="booking-item"><div><strong>'+escapeHtml(b.venueName)+' · '+escapeHtml(b.customerName)+'</strong><p>'+escapeHtml(b.city)+' · '+escapeHtml(b.date)+' · '+b.guests+' guests</p><p>'+escapeHtml(b.customerEmail)+'</p><p class="booking-amount">Full price: '+formatMoney(b.amountPaise)+'</p><p>'+escapeHtml(b.message||'No note from customer.')+'</p><span class="booking-status '+(b.status==='Declined'?'cancelled':'')+'">'+escapeHtml(b.status)+'</span></div><div class="booking-actions">'+(b.status==='Pending'?'<button class="quiet-button" data-owner-action="approve" data-id="'+b.id+'">Approve</button><button class="quiet-button" data-owner-action="decline" data-id="'+b.id+'">Decline</button>':'')+'</div></article>').join(''):'<p class="form-help">No booking requests yet.</p>';
  bookingsEl.querySelectorAll('[data-owner-action]').forEach(button=>button.addEventListener('click',async()=>{try{await api('/api/owner/bookings/'+button.dataset.id,{method:'PUT',body:JSON.stringify({action:button.dataset.ownerAction})});await loadOwnerWorkspace();showToast(button.dataset.ownerAction==='approve'?'Booking approved. The customer can now pay.':'Booking declined.');}catch(error){showToast(error.message);}}));
 }catch(error){venuesEl.innerHTML='<p class="form-status error">'+escapeHtml(error.message)+'</p>';}
}
function openVenue(id){
 selectedVenue=venues.find(v=>v.id===id)||null;if(!selectedVenue)return;
 const v=selectedVenue, image=document.querySelector('#venue-detail-image');
 image.src='https://images.unsplash.com/'+encodeURIComponent(v.image)+'?auto=format&fit=crop&w=1200&q=85';image.alt=v.alt;
 document.querySelector('#venue-detail-kind').textContent=v.kind;
 document.querySelector('#venue-detail-name').textContent=v.name;
 document.querySelector('#venue-detail-location').textContent='⌖  '+v.area+', '+v.city;
 document.querySelector('#venue-detail-description').textContent=v.description;
  document.querySelector('#venue-detail-meta').innerHTML='<span>★ '+Number(v.rating).toFixed(1)+' ('+Number(v.reviews)+' reviews)</span><span>Up to '+Number(v.capacity)+' guests</span><span>Full venue price '+escapeHtml(v.price)+'</span>';
 document.querySelector('#venue-dialog').showModal();
}
function openBooking(v){
 document.querySelector('#booking-status').textContent='';
 document.querySelector('#booking-venue-id').value=v.id;
 document.querySelector('#booking-venue-name').textContent=v.name+' · '+v.city;
 document.querySelector('#booking-price').textContent=formatMoney(v.price_paise);
 document.querySelector('#guest-count').max=v.capacity;document.querySelector('#guest-count').value=Math.min(20,v.capacity);
 const date=new Date();date.setDate(date.getDate()+1);const localDate=new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,10);
 const dateInput=document.querySelector('#event-date');dateInput.min=localDate;dateInput.value=localDate;checkAvailability();
 document.querySelector('#booking-dialog').showModal();
}
async function checkAvailability(){
 const message=document.querySelector('#availability-message');if(!selectedVenue)return;
 message.textContent='Checking availability…';message.classList.remove('unavailable');
 try{const date=document.querySelector('#event-date').value;const result=await api('/api/venues/'+selectedVenue.id+'/availability?date='+encodeURIComponent(date));message.textContent=result.available?'Date looks available':'This date is already booked';message.classList.toggle('unavailable',!result.available);document.querySelector('#booking-form button[type="submit"]').disabled=!result.available;}
 catch(error){message.textContent='Availability could not be checked. Try again.';message.classList.add('unavailable');document.querySelector('#booking-form button[type="submit"]').disabled=true;}
}
async function startCheckout(bookingId,venueName='Venue Vista booking'){
 if(!paymentConfig.enabled){showToast('Razorpay is not configured yet.');return;}
 if(typeof window.Razorpay!=='function'){showToast('Secure checkout could not load. Check your connection and try again.');return;}
 try{
  const order=await api('/api/bookings/'+bookingId+'/payment/order',{method:'POST',body:'{}'});
  const checkout=new window.Razorpay({key:order.keyId,amount:order.amount,currency:order.currency,name:'Venue Vista',description:venueName,order_id:order.orderId,prefill:{name:user?.name||'',email:user?.email||''},theme:{color:'#243b30'},handler:async response=>{
   try{const result=await api('/api/bookings/'+bookingId+'/payment/verify',{method:'POST',body:JSON.stringify(response)});if(result.status==='Confirmed'){showToast('Payment received. Your booking is confirmed.');}else{showToast(result.message||'Payment is processing.');}await loadBookings();}
   catch(error){showToast(error.message);await loadBookings();}
  }});
  checkout.on('payment.failed',response=>showToast(response.error?.description||'Payment did not complete. You can try again from your account.'));
  checkout.open();
 }catch(error){showToast(error.message);}
}
document.querySelector('#search-form').addEventListener('submit',async event=>{event.preventDefault();try{await loadVenues();document.querySelector('#venues').scrollIntoView({behavior:'smooth'});}catch(error){showToast(error.message);}});
document.querySelectorAll('.chip[data-kind]').forEach(button=>button.addEventListener('click',async()=>{category=button.dataset.kind;showSavedOnly=false;document.querySelector('#saved-filter').classList.remove('active');document.querySelectorAll('.chip[data-kind]').forEach(chip=>chip.classList.toggle('active',chip===button));try{await loadVenues();}catch(error){showToast(error.message);}}));
document.querySelector('#saved-filter').addEventListener('click',()=>{if(!user){openAuth('login');showToast('Sign in to view saved venues.');return;}showSavedOnly=!showSavedOnly;document.querySelector('#saved-filter').classList.toggle('active',showSavedOnly);render();});
document.querySelector('#clear').addEventListener('click',async()=>{locationInput.value='';occasion.value='all';category='all';showSavedOnly=false;document.querySelector('#saved-filter').classList.remove('active');document.querySelectorAll('.chip[data-kind]').forEach(chip=>chip.classList.toggle('active',chip.dataset.kind==='all'));try{await loadVenues();}catch(error){showToast(error.message);}});
document.querySelector('#account-button').addEventListener('click',()=>openAuth());
document.querySelectorAll('[data-close]').forEach(button=>button.addEventListener('click',()=>document.querySelector('#'+button.dataset.close).close()));
document.querySelectorAll('dialog').forEach(dialog=>dialog.addEventListener('click',event=>{if(event.target===dialog)dialog.close();}));
document.querySelector('#mode-switch').addEventListener('click',()=>setAuthMode('register'));
document.querySelector('#auth-form').addEventListener('submit',async event=>{
 event.preventDefault();const button=document.querySelector('#auth-submit');button.disabled=true;setStatus(authStatus,'Working…');
 const register=!document.querySelector('#name-field').hidden;
 const payload={email:document.querySelector('#auth-email').value,password:document.querySelector('#auth-password').value};
 if(register){payload.name=document.querySelector('#auth-name').value;payload.accountType=document.querySelector('#account-type').value;}
 try{const data=await api('/api/auth/'+(register?'register':'login'),{method:'POST',body:JSON.stringify(payload)});user=data.user;await refreshFavorites();document.querySelector('#account-button').textContent=user.name.split(' ')[0]+' · Account';authDialog.close();render();if(pendingBookingVenue){const venue=pendingBookingVenue;pendingBookingVenue=null;openBooking(venue);}else showToast(register?'Account created. You are signed in.':'Welcome back.');}
 catch(error){setStatus(authStatus,error.message,true);}finally{button.disabled=false;}
});
document.querySelector('#sign-out').addEventListener('click',async()=>{try{await api('/api/auth/logout',{method:'POST'});user=null;favorites.clear();document.querySelector('#account-button').textContent='Sign in';authDialog.close();render();showToast('You have signed out.');}catch(error){setStatus(authStatus,error.message,true);}});
document.querySelector('#venue-form').addEventListener('submit',async event=>{event.preventDefault();const form=event.currentTarget,button=form.querySelector('button[type="submit"]'),payload=Object.fromEntries(new FormData(form));button.disabled=true;try{await api('/api/owner/venues',{method:'POST',body:JSON.stringify(payload)});form.reset();await loadOwnerWorkspace();await loadVenues();showToast('Your venue is now listed.');}catch(error){showToast(error.message);}finally{button.disabled=false;}});
document.querySelector('#venue-request').addEventListener('click',()=>{const venue=selectedVenue;document.querySelector('#venue-dialog').close();if(!venue)return;if(!user){pendingBookingVenue=venue;openAuth('login');showToast('Sign in to request this venue.');return;}openBooking(venue);});
document.querySelector('#booking-form').addEventListener('submit',async event=>{
 event.preventDefault();const button=event.currentTarget.querySelector('button[type="submit"]');button.disabled=true;const status=document.querySelector('#booking-status');setStatus(status,'Sending your request…');
 const payload={venueId:Number(document.querySelector('#booking-venue-id').value),date:document.querySelector('#event-date').value,guests:Number(document.querySelector('#guest-count').value),message:document.querySelector('#booking-message').value};
  try{const result=await api('/api/bookings',{method:'POST',body:JSON.stringify(payload)});document.querySelector('#booking-dialog').close();event.currentTarget.reset();if(result.booking.status==='Approved'&&paymentConfig.enabled){await startCheckout(result.booking.id,selectedVenue?.name||'Venue booking');}else if(result.booking.status==='Pending'){showToast('Request sent. The venue owner will review it before payment.');}else{showToast('Booking request saved. Add Razorpay test keys to enable full-price checkout.');}if(user&&authDialog.open)loadBookings();}
 catch(error){setStatus(status,error.message,true);}finally{button.disabled=false;}
});
async function start(){
 try{const [me,data,payments]=await Promise.all([api('/api/me'),api('/api/venues'),api('/api/payments/config')]);user=me.user;venues=data.venues;paymentConfig=payments;if(user){document.querySelector('#account-button').textContent=user.name.split(' ')[0]+' · Account';await refreshFavorites();}document.querySelector('#event-date').addEventListener('change',checkAvailability);render();}
 catch(error){document.querySelector('#count').textContent='Venue Vista could not reach the server.';document.querySelector('#empty').hidden=false;document.querySelector('#empty').textContent='Start the app from VS Code with npm start, then refresh this page.';showToast(error.message);}
}
start();
