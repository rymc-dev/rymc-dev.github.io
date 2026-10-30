---
title: 'Autonomous Rover: ROS 2 Nav Stack'
summary: 'A differential-drive rover running Nav2 with LiDAR SLAM, custom behaviour trees and a Gazebo digital twin.'
date: 2026-09-15
tags: ['ros2', 'nav2', 'slam', 'c++']
repo: 'https://github.com/'
scene: 'lidar-scan'
featured: true
---

> Placeholder project. Replace this with your own write-up.

## Overview

Describe the problem, the robot, and what you set out to build.

## Architecture

- **Perception:** 2D/3D LiDAR → `slam_toolbox` for mapping and localisation
- **Planning:** Nav2 with a custom behaviour tree for docking
- **Control:** `ros2_control` diff-drive controller on a microcontroller over micro-ROS
- **Sim:** Gazebo world matching the real lab for CI regression tests

## Results

What worked, what didn't, numbers if you have them (localisation error, success rate, cycle time).

## Lessons learned

The interesting bugs go here.
