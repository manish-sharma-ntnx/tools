import streamlit as st
import pandas as pd
import requests
import plotly.express as px
import plotly.graph_objects as go
from datetime import datetime
from collections import Counter, defaultdict

st.set_page_config(page_title="MSP ONCALL Dashboard", layout="wide", initial_sidebar_state="collapsed")

# Define Custom CSS
st.markdown("""
<style>
.metric-row { display: flex; justify-content: space-between; gap: 10px; }
</style>
""", unsafe_allow_html=True)

@st.cache_data(ttl=60)
def fetch_data():
    try:
        r = requests.get("http://127.0.0.1:8050/api/data", timeout=10)
        if r.status_code == 202:
            return None, r.json().get("message", "Loading...")
        if r.status_code == 200:
            return r.json(), None
    except Exception as e:
        return None, f"Error connecting to backend: {e}"
    return None, f"Unexpected status {r.status_code}"

data, error = fetch_data()

if error:
    st.error(error)
    st.stop()

if not data:
    st.info("Loading data from backend...")
    if st.button("Refresh"):
        st.cache_data.clear()
        st.rerun()
    st.stop()

if data.get("error"):
    st.warning(f"⚠️ WARNING: Showing stale data. Connection to MCP failed. Last attempt error: {data['error']}")

# Header
st.title("MSP Engineering ONCALL Dashboard")
col_ts, col_btn = st.columns([8, 1])
with col_ts:
    st.markdown(f"**Last Refreshed:** {data.get('last_refreshed')} | **Refresh Interval:** {data.get('refresh_interval_min')} min")
with col_btn:
    if st.button("Refresh Now", use_container_width=True):
        st.cache_data.clear()
        requests.post("http://127.0.0.1:8050/api/refresh")
        st.rerun()

# Time Range
time_ranges = {
    "Last 1 Qtr": 3,
    "Last 2 Qtrs": 6,
    "Last 3 Qtrs": 9,
    "Last 1 Year": 12,
    "Last 2 Years": 24,
    "All Time": 0
}
selected_range = st.radio("Time Range:", list(time_ranges.keys()), index=3, horizontal=True)
months = time_ranges[selected_range]

# Tabs
tab_keys = ["oncall", "cfd", "cfi"]
tab_names = ["ONCALLs (Filter 174525)", "MSP-CFDs-Overall (Filter 181164)", "MSP-CFIs-Overall (Filter 181165)"]
tabs = st.tabs(tab_names)

def filter_data(issues, months):
    if months == 0:
        return issues
    cutoff = pd.Timestamp.now() - pd.DateOffset(months=months)
    return [i for i in issues if pd.to_datetime(i['created']).tz_localize(None) >= cutoff]

def top_n_chart(series_list, title, n=15, color_sequence=None, exclude=None):
    exclude = set(exclude or [])
    flat = [item for sublist in series_list for item in sublist if item not in exclude]
    counts = pd.Series(flat).value_counts().head(n).sort_values()
    fig = px.bar(x=counts.values, y=counts.index, orientation='h', title=title, color_discrete_sequence=color_sequence)
    fig.update_layout(xaxis_title="", yaxis_title="", margin=dict(l=0, r=0, t=30, b=0))
    return fig

FIX_VERSION_EXCLUDE = {"msp-master", "master"}

def render_tab(issues_raw, tab_id):
    issues = filter_data(issues_raw, months)
    
    if not issues:
        st.write("No issues found in the selected time range.")
        return
        
    df = pd.DataFrame(issues)
    df['created_dt'] = pd.to_datetime(df['created'])
    df['month'] = df['created_dt'].dt.to_period('M').astype(str)
    
    # KPIs
    total = len(df)
    open_count = df['is_open'].sum()
    closed_count = total - open_count
    high_impact = df['priority'].isin(['Blocker - P0', 'Critical - P1', 'Major - P2']).sum()
    sf_cases = (df['sf_cases'] > 0).sum()
    
    col1, col2, col3, col4, col5 = st.columns(5)
    col1.metric("Total (filtered)", total)
    col2.metric("Open (in range)", open_count)
    col3.metric("Closed (in range)", closed_count)
    col4.metric("High Impact (P0/P1/P2)", high_impact)
    col5.metric("With SF Cases", sf_cases)
    
    st.divider()
    
    # Determine primary color based on tab
    primary_color = "#3b82f6"
    if tab_id == 'cfd': primary_color = "#8b5cf6"
    elif tab_id == 'cfi': primary_color = "#ec4899"
    
    # Section 1
    st.subheader(f"1. Trends Across Months & Open vs Closed")
    col1, col2, col3 = st.columns(3)
    
    monthly_tot = df.groupby('month').size().reindex(
        pd.period_range(df['month'].min(), df['month'].max(), freq='M').astype(str), fill_value=0
    ).reset_index(name='count')
    monthly_tot.rename(columns={'index':'month'}, inplace=True)
    
    fig1 = px.line(monthly_tot, x='month', y='count', title="Monthly Trend", markers=True, color_discrete_sequence=[primary_color])
    fig1.update_layout(xaxis_title="", yaxis_title="", margin=dict(l=0, r=0, t=30, b=0))
    col1.plotly_chart(fig1, use_container_width=True)
    
    monthly_open = df[df['is_open']].groupby('month').size().reset_index(name='Open')
    monthly_closed = df[~df['is_open']].groupby('month').size().reset_index(name='Closed')
    m_oc = monthly_tot[['month']].merge(monthly_open, on='month', how='left').merge(monthly_closed, on='month', how='left').fillna(0)
    fig2 = go.Figure()
    fig2.add_trace(go.Scatter(x=m_oc['month'], y=m_oc['Open'], mode='lines+markers', name='Open', line=dict(color='#ef4444')))
    fig2.add_trace(go.Scatter(x=m_oc['month'], y=m_oc['Closed'], mode='lines+markers', name='Closed', line=dict(color='#22c55e')))
    fig2.update_layout(title="Open vs Closed per Month", margin=dict(l=0, r=0, t=30, b=0), legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1))
    col2.plotly_chart(fig2, use_container_width=True)
    
    monthly_sf = df.groupby('month')['sf_cases'].sum().reindex(monthly_tot['month'], fill_value=0).reset_index(name='sf_cases')
    fig3 = px.line(monthly_sf, x='month', y='sf_cases', title="SF Cases per Month", markers=True, color_discrete_sequence=['#a855f7'])
    fig3.update_layout(xaxis_title="", yaxis_title="", margin=dict(l=0, r=0, t=30, b=0))
    col3.plotly_chart(fig3, use_container_width=True)
    
    st.divider()
    
    # Section 2
    st.subheader("2. Trend Across Releases & Priority")
    col1, col2, col3 = st.columns(3)

    col1.plotly_chart(
        top_n_chart(df['fix_versions'], "Top Fix Version/s", 15, px.colors.qualitative.Plotly, exclude=FIX_VERSION_EXCLUDE),
        use_container_width=True,
    )
    col2.plotly_chart(top_n_chart(df['affects_versions'], "Top Affects Version/s", 15, px.colors.qualitative.Plotly), use_container_width=True)
    
    pri_counts = df['priority'].value_counts()
    pc_colors = {
        'Blocker - P0': '#dc2626',
        'Critical - P1': '#ea580c',
        'Major - P2': '#f59e0b',
        'Minor - P3': '#3b82f6',
        'Trivial - P4': '#6b7280'
    }
    colors = [pc_colors.get(p, '#94a3b8') for p in pri_counts.index]
    fig_pri = go.Figure(data=[go.Pie(labels=pri_counts.index, values=pri_counts.values, hole=0.4, marker_colors=colors)])
    fig_pri.update_layout(title="Priority Distribution", margin=dict(l=0, r=0, t=30, b=0), legend=dict(orientation="h", yanchor="bottom", y=-0.1))
    col3.plotly_chart(fig_pri, use_container_width=True)
    
    st.divider()

    # Section 2b: Tickets Fixed Per Release
    st.subheader("2b. Tickets Fixed Per Release")
    fixed_df = df[~df['is_open']]
    fixed_versions_flat = [
        v for sublist in fixed_df['fix_versions'] for v in sublist
        if v not in FIX_VERSION_EXCLUDE
    ]
    if fixed_versions_flat:
        fixed_counts = pd.Series(fixed_versions_flat).value_counts().head(25).sort_values()
        col1, col2 = st.columns([2, 1])
        fig_fix = px.bar(
            x=fixed_counts.values, y=fixed_counts.index, orientation='h',
            title=f"Closed/Resolved tickets per Fix Version ({len(fixed_df)} closed tickets)",
            color_discrete_sequence=['#16a34a'],
        )
        fig_fix.update_layout(xaxis_title="", yaxis_title="", margin=dict(l=0, r=0, t=30, b=0))
        col1.plotly_chart(fig_fix, use_container_width=True)
        with col2:
            st.dataframe(
                fixed_counts.sort_values(ascending=False).reset_index().rename(
                    columns={'index': 'Fix Version', 0: 'Closed Tickets'}
                ),
                use_container_width=True, hide_index=True,
            )
    else:
        st.info("No closed tickets with a fix version in the selected time range.")

    st.divider()

    # Section 3
    st.subheader("3. Trend Across Components & Impact")
    col1, col2 = st.columns(2)
    col1.plotly_chart(top_n_chart(df['components'], "Top Components", 20, ['#ec4899']), use_container_width=True)
    col2.plotly_chart(top_n_chart(df['impacts'], "Top Impacts", 20, ['#14b8a6']), use_container_width=True)
    
    st.divider()
    
    # Section 4
    st.subheader("4. Trend Across Reporters & Labels")
    col1, col2 = st.columns(2)
    rep_counts = df['reporter'].value_counts().head(20).sort_values()
    fig_rep = px.bar(x=rep_counts.values, y=rep_counts.index, orientation='h', title="Top Reporters", color_discrete_sequence=['#8b5cf6'])
    fig_rep.update_layout(xaxis_title="", yaxis_title="", margin=dict(l=0, r=0, t=30, b=0))
    col1.plotly_chart(fig_rep, use_container_width=True)
    
    col2.plotly_chart(top_n_chart(df['labels'], "Top Labels", 20, ['#06b6d4']), use_container_width=True)

    st.divider()
    
    # Section 5: Monthly Labels Trend
    st.subheader("5. Monthly Labels Trend")
    all_labels = [item for sublist in df['labels'] for item in sublist]
    top_labels = pd.Series(all_labels).value_counts().head(20).index.tolist()
    
    selected_labels = st.multiselect("Select Labels to view", top_labels, default=top_labels[:5])
    
    if selected_labels:
        # Create a dataframe for labels by month
        lbl_data = []
        for i, row in df.iterrows():
            m = row['month']
            for lbl in row['labels']:
                if lbl in selected_labels:
                    lbl_data.append({'month': m, 'label': lbl})
        
        if lbl_data:
            df_lbl = pd.DataFrame(lbl_data)
            lbl_grouped = df_lbl.groupby(['month', 'label']).size().reset_index(name='count')
            fig_lbl = px.bar(lbl_grouped, x='month', y='count', color='label', title="Labels per Month", barmode='stack')
            
            # Add line for total
            fig_lbl.add_trace(go.Scatter(x=monthly_tot['month'], y=monthly_tot['count'], mode='lines+markers', name=f'Total', line=dict(color=primary_color, width=2)))
            
            fig_lbl.update_layout(margin=dict(l=0, r=0, t=30, b=0), legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1))
            st.plotly_chart(fig_lbl, use_container_width=True)
        else:
            st.write("No data for selected labels in this time range.")
            
    st.divider()
    
    # Tables
    st.subheader("6. Tickets with High Salesforce Cases Attached")
    df_disp = df[['key', 'summary', 'status', 'priority', 'created', 'assignee', 'components', 'sf_cases']].copy()
    df_disp['components'] = df_disp['components'].apply(lambda x: ", ".join(x) if isinstance(x, list) else x)
    
    sf_df = df_disp[df_disp['sf_cases'] > 0].sort_values('sf_cases', ascending=False).head(100)
    st.dataframe(sf_df, use_container_width=True, hide_index=True)
    
    st.subheader("7. High Impact ONCalls (P0 / P1 / P2)")
    hi_df = df_disp[df_disp['priority'].isin(['Blocker - P0', 'Critical - P1', 'Major - P2'])]
    st.dataframe(hi_df, use_container_width=True, hide_index=True)
    
    st.subheader(f"8. Currently Open ONCalls ({open_count})")
    op_df = df_disp[df['is_open']]
    st.dataframe(op_df, use_container_width=True, hide_index=True)
    
    st.subheader(f"9. All ONCalls in Selected Range ({total})")
    st.dataframe(df_disp.sort_values('created', ascending=False), use_container_width=True, hide_index=True)


for i, tab_key in enumerate(tab_keys):
    with tabs[i]:
        render_tab(data.get(tab_key, []), tab_key)
