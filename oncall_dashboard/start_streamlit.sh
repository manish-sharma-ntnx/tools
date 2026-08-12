#!/bin/bash
export PATH="$HOME/.local/bin:$PATH"
python3.9 -m streamlit run /home/manish.sharma/Nutanix/github/oncall_dashboard/streamlit_app.py --server.port 8051 --server.address 0.0.0.0
