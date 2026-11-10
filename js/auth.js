// Shared authentication helpers for all protected pages.
import { supabase } from './config.js';

// Redirects to the login page if no valid session exists.
export async function requireSession() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    window.location.replace('index.html');
    return null;
  }
  return session;
}

// Reads the profile (name and role) of the given user.
export async function getProfile(userId) {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, full_name, role')
    .eq('id', userId)
    .single();
  if (error) throw error;
  return data;
}

export async function signOut() {
  await supabase.auth.signOut();
  window.location.replace('index.html');
}

// Builds the common header: navigation, user name, role, logout.
// textContent is used for user data to prevent HTML injection.
export function renderHeader(profile, activePage) {
  const header = document.getElementById('app-header');
  header.innerHTML = `
    <div class="brand">J2050 Team Management</div>
    <nav>
      <a href="shifts.html" data-page="shifts">Lab shifts</a>
      <a href="gantt.html" data-page="gantt">Gantt</a>
    </nav>
    <div class="user">
      <span id="user-name"></span>
      <span id="user-role" class="badge"></span>
      <button id="logout-btn" type="button">Log out</button>
    </div>`;
  header.querySelector(`[data-page="${activePage}"]`)?.classList.add('active');
  header.querySelector('#user-name').textContent = profile.full_name ?? '';
  header.querySelector('#user-role').textContent = profile.role;
  header.querySelector('#logout-btn').addEventListener('click', signOut);
}

// Common start-up sequence of a protected page.
// Returns the profile, or null if the user is redirected to login.
export async function initProtectedPage(activePage) {
  const session = await requireSession();
  if (!session) return null;
  try {
    const profile = await getProfile(session.user.id);
    renderHeader(profile, activePage);
    return profile;
  } catch (err) {
    document.getElementById('app-main').textContent =
      'Profile not found or not readable. Contact an administrator.';
    console.error(err);
    return null;
  }
}
